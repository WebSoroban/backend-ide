/**
 * Soroban security audit.
 *
 * Two layers, merged + de-duplicated:
 *   1. A deterministic, curated rule checklist (lexical/heuristic static checks)
 *      over the Rust sources — fast, free, always runs.
 *   2. An optional LLM pass driven by the SAME rule list (best-effort; uses the
 *      run's model). This is the fallback for OpenZeppelin's Soroban Security
 *      Detector when that isn't wired in.
 *
 * Findings carry severity + file/line + a concrete suggested fix.
 */
import { completeChat } from './openrouter';
import type { SecurityFinding, ReasoningEffort } from './types';

interface SourceFile {
  path: string;
  content: string;
}

const STATE_MUTATIONS = /\.(set|remove|extend_ttl|update)\s*\(|events\(\)\.publish/;
const ADMIN_FN = /\b(set_admin|transfer_admin|mint|burn|upgrade|pause|unpause|withdraw|set_owner|grant_role|revoke_role|initialize|init)\b/i;
const SECRET_SEED = /\bS[A-Z2-7]{55}\b/; // Stellar secret seed
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function hashId(...parts: (string | number | undefined)[]): string {
  const s = parts.join('|');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return 'sec_' + Math.abs(h).toString(36);
}

/** Naive split of a Rust file into top-level `pub fn` bodies for per-fn checks. */
function eachFunction(content: string): { name: string; body: string; startLine: number }[] {
  const lines = content.split('\n');
  const out: { name: string; body: string; startLine: number }[] = [];
  const fnRe = /\bpub\s+fn\s+([a-zA-Z_][a-zA-Z0-9_]*)/;
  for (let i = 0; i < lines.length; i++) {
    const m = fnRe.exec(lines[i]);
    if (!m) continue;
    // Collect until brace depth returns to 0 (best-effort).
    let depth = 0;
    let started = false;
    const bodyLines: string[] = [];
    let j = i;
    for (; j < lines.length; j++) {
      const l = lines[j];
      for (const ch of l) {
        if (ch === '{') {
          depth++;
          started = true;
        } else if (ch === '}') depth--;
      }
      bodyLines.push(l);
      if (started && depth <= 0) break;
    }
    out.push({ name: m[1], body: bodyLines.join('\n'), startLine: i + 1 });
  }
  return out;
}

/** The deterministic Soroban rule checklist. */
export function auditStatic(files: SourceFile[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const rsFiles = files.filter((f) => f.path.endsWith('.rs'));
  const allManifests = files.filter((f) => f.path.endsWith('Cargo.toml')).map((f) => f.content).join('\n');
  const overflowChecks = /overflow-checks\s*=\s*true/.test(allManifests);

  for (const f of rsFiles) {
    const lines = f.content.split('\n');

    // R8: secrets / private keys committed in source (critical).
    lines.forEach((l, idx) => {
      if (SECRET_SEED.test(l) || PRIVATE_KEY_BLOCK.test(l)) {
        findings.push({
          id: hashId('R8', f.path, idx),
          severity: 'critical',
          rule: 'secrets-in-code',
          title: 'Possible secret key / seed committed in source',
          file: f.path,
          line: idx + 1,
          detail: 'A Stellar secret seed or private key appears to be hardcoded. Secrets must never live in contract source.',
          suggestedFix: 'Remove the secret. Keys belong in server-side encrypted storage, never in the contract or repo.',
        });
      }
    });

    // R4: persistent storage without any TTL extension in the file.
    const usesPersistent = /storage\(\)\s*\.\s*persistent\(\)/.test(f.content);
    const extendsTtl = /extend_ttl|bump/.test(f.content);
    if (usesPersistent && !extendsTtl) {
      const idx = lines.findIndex((l) => /persistent\(\)/.test(l));
      findings.push({
        id: hashId('R4', f.path),
        severity: 'medium',
        rule: 'storage-ttl',
        title: 'Persistent storage without a TTL extension',
        file: f.path,
        line: idx >= 0 ? idx + 1 : undefined,
        detail: 'Persistent entries can be archived/expire if their TTL is not extended, risking data loss.',
        suggestedFix: 'Call storage().persistent().extend_ttl(&key, threshold, extend_to) after writes to keep entries alive.',
      });
    }

    // R3: unchecked arithmetic on amounts when overflow-checks is off.
    if (!overflowChecks) {
      lines.forEach((l, idx) => {
        const looksMoney = /(amount|balance|total|supply|i128|u128)/.test(l);
        const rawMath = /[^+\-*/=!<>]\s*[+\-*]\s*[^+\-*/=]/.test(l) && !/checked_|saturating_|wrapping_/.test(l);
        if (looksMoney && rawMath && !l.trim().startsWith('//')) {
          findings.push({
            id: hashId('R3', f.path, idx),
            severity: 'high',
            rule: 'unchecked-arithmetic',
            title: 'Possible unchecked arithmetic on a value amount',
            file: f.path,
            line: idx + 1,
            detail: 'Arithmetic on token amounts without checked_*/overflow-checks can silently overflow.',
            suggestedFix: 'Use checked_add/checked_sub/checked_mul and return a #[contracterror], or set overflow-checks = true in [profile.release].',
          });
        }
      });
    }

    // R5: panics reachable from inputs (unwrap/expect/panic).
    lines.forEach((l, idx) => {
      if (l.trim().startsWith('//')) return;
      if (/\.unwrap\(\)|\.expect\(|panic!\s*\(/.test(l)) {
        findings.push({
          id: hashId('R5', f.path, idx),
          severity: 'medium',
          rule: 'panic-on-input',
          title: 'Panic / unwrap reachable from contract logic',
          file: f.path,
          line: idx + 1,
          detail: 'unwrap()/expect()/panic! abort the transaction with no typed error. If reachable from user input, this is a denial path.',
          suggestedFix: 'Return a #[contracterror] via Result<T, Error> instead of panicking on user-controlled values.',
        });
      }
    });

    // Per-function checks: auth on state mutations / admin functions.
    for (const fn of eachFunction(f.content)) {
      const mutates = STATE_MUTATIONS.test(fn.body);
      const hasAuth = /require_auth(_for_args)?\s*\(/.test(fn.body);
      const isAdmin = ADMIN_FN.test(fn.name);
      const takesAddress = /:\s*Address\b/.test(fn.body.split('{')[0] || '');

      if (mutates && !hasAuth && (isAdmin || takesAddress)) {
        findings.push({
          id: hashId('R1', f.path, fn.name),
          severity: isAdmin ? 'high' : 'medium',
          rule: 'missing-require-auth',
          title: `Function \`${fn.name}\` mutates state without require_auth`,
          file: f.path,
          line: fn.startLine,
          detail: `\`${fn.name}\` writes state${isAdmin ? ' and looks privileged' : ''} but has no require_auth() — anyone could call it.`,
          suggestedFix: `Load the relevant Address (caller or stored admin) and call \`.require_auth()\` before mutating state in \`${fn.name}\`.`,
        });
      }

      // R6: unbounded loop over a collection.
      if (/\bfor\b[^\n]*\.(iter|keys|values)\(\)/.test(fn.body)) {
        const idx = fn.startLine;
        findings.push({
          id: hashId('R6', f.path, fn.name),
          severity: 'low',
          rule: 'unbounded-loop',
          title: `Loop over a collection in \`${fn.name}\` may be unbounded`,
          file: f.path,
          line: idx,
          detail: 'Iterating a user-growable Vec/Map can exceed the resource budget and brick the function.',
          suggestedFix: 'Bound the collection size, paginate, or use indexed lookups instead of full scans.',
        });
      }
    }
  }

  return findings;
}

const RULE_LIST_FOR_LLM = `Audit this Soroban (Stellar) Rust contract against these rules and report ONLY real issues:
1. Missing require_auth on state-changing or admin/owner functions.
2. Unprotected admin/owner/privileged functions (mint, burn, upgrade, pause, set_admin, withdraw).
3. Unchecked arithmetic on token amounts (i128/u128) that can overflow.
4. Persistent/instance storage with no TTL extension (data can expire / be archived).
5. Panics reachable from user input (unwrap/expect/panic!) instead of typed #[contracterror].
6. Unbounded loops over user-growable collections (budget/DoS).
7. Improper error handling (swallowing errors, wrong Result usage).
8. Secrets/keys hardcoded in source.`;

const FINDINGS_SCHEMA_HINT = `Return STRICT JSON: {"findings":[{"severity":"critical|high|medium|low|info","rule":"short-id","title":"...","file":"src/lib.rs","line":12,"detail":"...","suggestedFix":"..."}]}. If nothing is wrong, return {"findings":[]}.`;

export interface AuditOptions {
  /** Run the LLM augmentation pass (best-effort). */
  useLlm?: boolean;
  model?: string;
  apiKey?: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}

/** Best-effort LLM audit driven by the rule list. Returns [] on any failure. */
async function auditLlm(files: SourceFile[], opts: AuditOptions): Promise<SecurityFinding[]> {
  if (!opts.useLlm || !opts.model) return [];
  const src = files
    .filter((f) => f.path.endsWith('.rs'))
    .map((f) => `// FILE: ${f.path}\n${f.content}`)
    .join('\n\n')
    .slice(0, 60000); // keep the prompt bounded
  try {
    const res = await completeChat({
      model: opts.model,
      apiKey: opts.apiKey,
      reasoning_effort: opts.reasoningEffort || 'medium',
      response_format: { type: 'json_object' },
      signal: opts.signal,
      messages: [
        { role: 'system', content: `You are a meticulous Soroban security auditor. ${FINDINGS_SCHEMA_HINT}` },
        { role: 'user', content: `${RULE_LIST_FOR_LLM}\n\n${src}` },
      ],
    });
    const parsed = JSON.parse(res.content || '{"findings":[]}');
    const arr = Array.isArray(parsed.findings) ? parsed.findings : [];
    return arr.map((f: any, i: number): SecurityFinding => ({
      id: hashId('LLM', f.file, f.line, i),
      severity: ['critical', 'high', 'medium', 'low', 'info'].includes(f.severity) ? f.severity : 'info',
      rule: String(f.rule || 'llm'),
      title: String(f.title || 'Security finding'),
      file: f.file ? String(f.file) : undefined,
      line: typeof f.line === 'number' ? f.line : undefined,
      detail: String(f.detail || ''),
      suggestedFix: String(f.suggestedFix || ''),
    }));
  } catch (e: any) {
    console.warn('[securityAudit] LLM pass skipped:', e.message);
    return [];
  }
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** Run the full audit (static + optional LLM), merged + de-duplicated + sorted. */
export async function audit(files: SourceFile[], opts: AuditOptions = {}): Promise<SecurityFinding[]> {
  const [staticFindings, llmFindings] = await Promise.all([
    Promise.resolve(auditStatic(files)),
    auditLlm(files, opts),
  ]);

  const merged: SecurityFinding[] = [...staticFindings];
  const seen = new Set(staticFindings.map((f) => `${f.rule}|${f.file}|${f.line}`));
  for (const f of llmFindings) {
    const key = `${f.rule}|${f.file}|${f.line}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(f);
    }
  }

  return merged.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9));
}

export default { audit, auditStatic };
