/**
 * Tool executor + project working-copy.
 *
 * A ProjectWorkspace holds an in-memory copy of the project's files. The agent's
 * edits mutate THIS copy (so its own validation loop — run_compile/run_tests —
 * sees its in-progress code), while the original snapshot is kept as the
 * checkpoint that powers per-run undo. Net edits (vs the snapshot) are surfaced
 * as reviewable diffs; nothing is written to the database until the user accepts.
 *
 * Every path is run through the shared sanitizer (lib/paths) and scoped to the
 * project — the same containment rules the build workers enforce. Compile / test
 * reuse the real pipeline services; clippy is a thin cargo runner. deploy is NOT
 * here — it's a gated UI action.
 */
import { spawn } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { sanitizeRelPath, dirOfPath } from '../../lib/paths';
import { materializeTree } from '../projectLayout';
import { parseDiagnostics, type Diagnostic } from '../diagnostics';
import compilationService from '../compilationService';
import testService from '../testService';
import { parseSpecFunctions, type SpecFunction } from '../contractSpec';
import { audit as runAudit } from './securityAudit';
import { unifiedDiff } from './diff';
import { isToolAllowed, EDIT_TOOLS } from './tools';
import type { CopilotMode, ProposedEdit, ReasoningEffort } from './types';

export interface ExecContext {
  runId: string;
  projectId: string;
  userId: string;
  mode: CopilotMode;
  manifestPath: string;
  deployTarget?: string | null;
  contractAddress?: string | null;
  /** persisted ParsedSpec ({ entries, functions }) if the project has compiled */
  spec?: { entries?: string[]; functions?: SpecFunction[] } | null;
  model: string;
  apiKey?: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  /** text handed back to the model as the tool result */
  content: string;
  /** structured payload for the UI timeline (diff / diagnostics / findings) */
  data?: any;
  /** present for edit tools */
  edit?: ProposedEdit;
}

const MAX_READ = 60000;

export class ProjectWorkspace {
  private files = new Map<string, string>();
  private baseline = new Map<string, string>();
  private deleted = new Set<string>();
  lastDiagnostics: Diagnostic[] = [];
  private seq = 0;

  constructor(initial: { path: string; content: string }[], private ctx: ExecContext) {
    for (const f of initial) {
      this.files.set(f.path, f.content ?? '');
      this.baseline.set(f.path, f.content ?? '');
    }
  }

  /** The immutable pre-run snapshot — stored on the run for undo. */
  snapshot(): { path: string; content: string }[] {
    return [...this.baseline.entries()].map(([p, content]) => ({ path: p, content }));
  }

  /** Current working file set (excludes deleted) for compile/test/clippy/audit. */
  currentFiles(): { path: string; content: string }[] {
    return [...this.files.entries()]
      .filter(([p]) => !this.deleted.has(p))
      .map(([p, content]) => ({ path: p, content }));
  }

  /** Net edits vs the snapshot — the diff set the user reviews. */
  netEdits(): ProposedEdit[] {
    const edits: ProposedEdit[] = [];
    const paths = new Set([...this.baseline.keys(), ...this.files.keys()]);
    for (const p of paths) {
      const before = this.baseline.get(p);
      const deleted = this.deleted.has(p);
      const after = deleted ? undefined : this.files.get(p);
      if (deleted && before !== undefined) {
        edits.push({ op: 'delete', path: p, previousContent: before, diff: unifiedDiff(p, before, '') });
      } else if (before === undefined && after !== undefined) {
        edits.push({ op: 'create', path: p, content: after, diff: unifiedDiff(p, '', after) });
      } else if (before !== undefined && after !== undefined && before !== after) {
        edits.push({ op: 'modify', path: p, content: after, previousContent: before, diff: unifiedDiff(p, before, after) });
      }
    }
    return edits;
  }

  hasEdits(): boolean {
    return this.netEdits().length > 0;
  }

  // -------------------------------------------------------------------------

  async execute(name: string, args: Record<string, any>): Promise<ToolResult> {
    if (!isToolAllowed(this.ctx.mode, name)) {
      return { ok: false, content: `Tool "${name}" is not permitted in ${this.ctx.mode.toUpperCase()} mode.` };
    }
    try {
      switch (name) {
        case 'read_file':
          return this.readFile(args.path);
        case 'list_files':
          return this.listFiles();
        case 'search_codebase':
          return this.search(args.query);
        case 'get_errors':
          return this.getErrors();
        case 'get_contract_spec':
          return this.getSpec();
        case 'fetch_docs':
          return this.fetchDocs(args.query);
        case 'create_file':
          return this.writeFile(args.path, args.content ?? '', args.summary, true);
        case 'propose_edit':
          return this.writeFile(args.path, args.content ?? '', args.summary, false);
        case 'delete_file':
          return this.deleteFile(args.path);
        case 'run_compile':
          return await this.runCompile();
        case 'run_tests':
          return await this.runTests();
        case 'run_clippy':
          return await this.runClippy();
        case 'run_security_audit':
          return await this.runSecurityAudit();
        default:
          return { ok: false, content: `Unknown tool "${name}".` };
      }
    } catch (e: any) {
      return { ok: false, content: `Tool "${name}" failed: ${e.message}` };
    }
  }

  private safePath(p: any): string {
    if (typeof p !== 'string') throw new Error('path must be a string');
    return sanitizeRelPath(p);
  }

  private readFile(p: string): ToolResult {
    const rel = this.safePath(p);
    if (this.deleted.has(rel) || !this.files.has(rel)) {
      return { ok: false, content: `File not found: ${rel}` };
    }
    const content = this.files.get(rel)!;
    const truncated = content.length > MAX_READ;
    const body = truncated ? content.slice(0, MAX_READ) + '\n… (truncated)' : content;
    return { ok: true, content: `// ${rel}\n${body}`, data: { path: rel, bytes: content.length } };
  }

  private listFiles(): ToolResult {
    const list = this.currentFiles().map((f) => f.path).sort();
    return { ok: true, content: list.join('\n'), data: { files: list } };
  }

  private search(query: string): ToolResult {
    if (!query || typeof query !== 'string') return { ok: false, content: 'query is required' };
    const q = query.toLowerCase();
    const matches: { file: string; line: number; text: string }[] = [];
    for (const f of this.currentFiles()) {
      const lines = f.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          matches.push({ file: f.path, line: i + 1, text: lines[i].trim().slice(0, 200) });
          if (matches.length >= 50) break;
        }
      }
      if (matches.length >= 50) break;
    }
    const text = matches.length
      ? matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n')
      : `No matches for "${query}".`;
    return { ok: true, content: text, data: { matches } };
  }

  private getErrors(): ToolResult {
    if (!this.lastDiagnostics.length) {
      return { ok: true, content: 'No diagnostics yet. Run run_compile to get current errors.', data: { diagnostics: [] } };
    }
    const text = this.lastDiagnostics
      .map((d) => `${d.level.toUpperCase()}${d.code ? `[${d.code}]` : ''} ${d.file || '?'}:${d.line ?? '?'} — ${d.message}`)
      .join('\n');
    return { ok: true, content: text, data: { diagnostics: this.lastDiagnostics } };
  }

  private getSpec(): ToolResult {
    let fns: SpecFunction[] | undefined = this.ctx.spec?.functions;
    if ((!fns || !fns.length) && this.ctx.spec?.entries?.length) {
      try {
        fns = parseSpecFunctions(this.ctx.spec.entries);
      } catch {
        /* ignore */
      }
    }
    if (!fns || !fns.length) {
      return { ok: true, content: 'No contract spec available yet. Compile the contract first (run_compile).', data: { functions: [] } };
    }
    const text = fns
      .map((f) => `${f.name}(${f.inputs.map((i) => `${i.name}: ${i.type}`).join(', ')}) -> ${f.outputs.join(', ') || '()'}`)
      .join('\n');
    return { ok: true, content: text, data: { functions: fns } };
  }

  private fetchDocs(query: string): ToolResult {
    const q = (query || '').toLowerCase();
    const hits = DOCS.filter((d) => d.keys.some((k) => q.includes(k)));
    if (!hits.length) {
      return {
        ok: true,
        content: `No bundled doc snippet for "${query}". Topics: ${DOCS.map((d) => d.keys[0]).join(', ')}.`,
        data: { docs: [] },
      };
    }
    return { ok: true, content: hits.map((h) => `### ${h.title}\n${h.body}`).join('\n\n'), data: { docs: hits } };
  }

  private writeFile(p: string, content: string, summary: string | undefined, mustBeNew: boolean): ToolResult {
    const rel = this.safePath(p);
    const existedInBaseline = this.baseline.has(rel) && !this.deleted.has(rel);
    if (mustBeNew && existedInBaseline) {
      return { ok: false, content: `create_file: ${rel} already exists. Use propose_edit to modify it.` };
    }
    const prev = this.deleted.has(rel) ? '' : this.files.get(rel) ?? '';
    this.deleted.delete(rel);
    this.files.set(rel, content);
    const op = existedInBaseline ? 'modify' : 'create';
    const diff = unifiedDiff(rel, prev, content);
    const edit: ProposedEdit = { op, path: rel, content, previousContent: prev || undefined, diff };
    return {
      ok: true,
      content: `${op === 'create' ? 'Created' : 'Edited'} ${rel}${summary ? ` — ${summary}` : ''}. Diff produced for review.`,
      data: { path: rel, op, summary },
      edit,
    };
  }

  private deleteFile(p: string): ToolResult {
    const rel = this.safePath(p);
    if (!this.files.has(rel) || this.deleted.has(rel)) {
      return { ok: false, content: `delete_file: ${rel} does not exist.` };
    }
    const prev = this.files.get(rel)!;
    this.deleted.add(rel);
    const edit: ProposedEdit = { op: 'delete', path: rel, previousContent: prev, diff: unifiedDiff(rel, prev, '') };
    return { ok: true, content: `Marked ${rel} for deletion (review required).`, data: { path: rel, op: 'delete' }, edit };
  }

  private async runCompile(): Promise<ToolResult> {
    const jobId = `ai-${this.ctx.runId}-compile-${this.seq++}`;
    const result: any = await compilationService.compileProject(
      this.ctx.projectId,
      this.currentFiles(),
      null,
      jobId,
      { manifestPath: this.ctx.manifestPath, deployTarget: this.ctx.deployTarget }
    );
    const diagnostics = parseDiagnostics(result.logs || []);
    this.lastDiagnostics = diagnostics;
    const wasm = result.wasmBase64 || result.output?.wasm;
    const wasmBytes = wasm ? Buffer.from(wasm, 'base64').length : 0;
    const errors = diagnostics.filter((d) => d.level === 'error');
    const warnings = diagnostics.filter((d) => d.level === 'warning');

    const summary = result.success
      ? `Compiled successfully. WASM ${(wasmBytes / 1024).toFixed(1)} KB${warnings.length ? `, ${warnings.length} warning(s)` : ''}.`
      : `Compilation FAILED with ${errors.length} error(s).`;
    const detail = diagnostics.length
      ? '\n' + diagnostics
          .slice(0, 40)
          .map((d) => `${d.level}${d.code ? `[${d.code}]` : ''} ${d.file || '?'}:${d.line ?? '?'} — ${d.message}`)
          .join('\n')
      : result.success
        ? ''
        : `\n${result.error || 'Unknown compile error.'}`;

    return {
      ok: result.success,
      content: summary + detail,
      data: { success: result.success, diagnostics, wasmBytes, errorCount: errors.length, warningCount: warnings.length },
    };
  }

  private async runTests(): Promise<ToolResult> {
    const jobId = `ai-${this.ctx.runId}-test-${this.seq++}`;
    const result = await testService.runTests(this.ctx.projectId, this.currentFiles(), null, jobId, {
      manifestPath: this.ctx.manifestPath,
      deployTarget: this.ctx.deployTarget,
    });
    if (result.compileFailed) {
      const diags = parseDiagnostics(result.logs || []);
      this.lastDiagnostics = diags;
      return {
        ok: false,
        content: `Tests failed to COMPILE.\n${diags.slice(0, 30).map((d) => `${d.file || '?'}:${d.line ?? '?'} ${d.message}`).join('\n')}`,
        data: { compileFailed: true, diagnostics: diags },
      };
    }
    const failed = result.tests.filter((t) => !t.passed && !t.ignored);
    const summary = `Tests: ${result.passed}/${result.total} passed${result.failed ? `, ${result.failed} failed` : ''}.`;
    const detail = failed.length
      ? '\n' + failed.map((t) => `✗ ${t.name}${t.file ? ` (${t.file})` : ''}${t.output ? `\n  ${t.output.split('\n').slice(0, 4).join('\n  ')}` : ''}`).join('\n')
      : '';
    return {
      ok: result.success,
      content: summary + detail,
      data: { success: result.success, total: result.total, passed: result.passed, failed: result.failed, tests: result.tests },
    };
  }

  private async runClippy(): Promise<ToolResult> {
    const baseDir = path.join(os.tmpdir(), 'soroban-clippy', `${this.ctx.runId}-${this.seq++}`);
    try {
      await fs.remove(baseDir);
      await fs.ensureDir(baseDir);
      await materializeTree(baseDir, this.currentFiles());
      const manifestDir = dirOfPath(this.ctx.manifestPath);
      const buildDir = manifestDir ? path.join(baseDir, manifestDir) : baseDir;
      const targetDir = path.join(buildDir, 'target');
      await fs.ensureDir(targetDir);

      const output = await new Promise<{ code: number; text: string }>((resolve) => {
        const proc = spawn('cargo', ['clippy', '--quiet', '--all-targets'], {
          cwd: buildDir,
          env: { ...process.env, CARGO_TARGET_DIR: targetDir, HOME: buildDir, USER: 'root' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let text = '';
        proc.stdout.on('data', (d: Buffer) => (text += d.toString()));
        proc.stderr.on('data', (d: Buffer) => (text += d.toString()));
        proc.on('error', (err) => resolve({ code: -1, text: `clippy unavailable: ${err.message}` }));
        proc.on('close', (code) => resolve({ code: code ?? 0, text }));
        this.ctx.signal?.addEventListener('abort', () => proc.kill('SIGKILL'), { once: true });
      });

      if (output.code === -1) {
        return { ok: true, content: output.text, data: { available: false } };
      }
      const logs = output.text.split('\n').map((message) => ({ type: 'info', message, timestamp: '' }));
      const diags = parseDiagnostics(logs as any);
      const warnings = diags.filter((d) => d.level === 'warning');
      const errors = diags.filter((d) => d.level === 'error');
      const summary = diags.length
        ? `Clippy: ${errors.length} error(s), ${warnings.length} warning(s).`
        : 'Clippy: no findings.';
      const detail = diags.length
        ? '\n' + diags.slice(0, 40).map((d) => `${d.level} ${d.file || '?'}:${d.line ?? '?'} — ${d.message}`).join('\n')
        : '';
      return { ok: true, content: summary + detail, data: { diagnostics: diags } };
    } catch (e: any) {
      return { ok: true, content: `Clippy could not run: ${e.message}`, data: { available: false } };
    } finally {
      fs.remove(baseDir).catch(() => {});
    }
  }

  private async runSecurityAudit(): Promise<ToolResult> {
    const findings = await runAudit(this.currentFiles(), {
      useLlm: true,
      model: this.ctx.model,
      apiKey: this.ctx.apiKey,
      reasoningEffort: this.ctx.reasoningEffort,
      signal: this.ctx.signal,
    });
    if (!findings.length) {
      return { ok: true, content: 'Security audit: no issues found against the Soroban rule checklist.', data: { findings: [] } };
    }
    const text = findings
      .map((f) => `[${f.severity.toUpperCase()}] ${f.title}${f.file ? ` (${f.file}:${f.line ?? '?'})` : ''}\n  ${f.detail}\n  Fix: ${f.suggestedFix}`)
      .join('\n\n');
    return { ok: true, content: text, data: { findings } };
  }
}

// A tiny bundled doc set for fetch_docs (keeps it offline + deterministic).
const DOCS: { keys: string[]; title: string; body: string }[] = [
  { keys: ['ttl', 'extend', 'expire', 'archive'], title: 'Storage TTL', body: 'Persistent/instance entries have a TTL and can be archived when it lapses. Extend it after writes: `env.storage().persistent().extend_ttl(&key, threshold, extend_to)`. Use temporary() for short-lived data.' },
  { keys: ['auth', 'require_auth', 'address'], title: 'Authorization', body: 'Call `addr.require_auth()` on any state change made on behalf of a user. For admin actions, load the stored admin Address and call `admin.require_auth()` before the privileged write.' },
  { keys: ['storage', 'persistent', 'instance', 'temporary'], title: 'Storage tiers', body: 'instance(): small contract-global config. persistent(): per-entity durable state (extend TTL!). temporary(): ephemeral (nonces/locks).' },
  { keys: ['event', 'publish', 'topic'], title: 'Events', body: 'Emit events for state changes: `env.events().publish((symbol_short!("transfer"), from, to), amount);`' },
  { keys: ['error', 'contracterror', 'panic', 'result'], title: 'Errors', body: 'Define `#[contracterror] pub enum Error { ... = 1 }` and return `Result<T, Error>`. Do not panic on user input.' },
  { keys: ['token', 'sep-41', 'sep41', 'fungible'], title: 'Tokens (SEP-41)', body: 'Implement the SEP-41 token interface (balance, transfer, approve, allowance, mint/burn with auth). Prefer OpenZeppelin stellar-tokens for a vetted base.' },
  { keys: ['test', 'testutils', 'client'], title: 'Testing', body: 'In `#[cfg(test)]`, build `Env::default()`, `env.register(Contract, ())`, then use the generated `<Contract>Client`. `env.mock_all_auths()` to bypass auth in tests.' },
  { keys: ['upgrade', 'upgradeable', 'wasm'], title: 'Upgradeability', body: 'Store an admin, gate `upgrade(new_wasm_hash)` with `admin.require_auth()`, then `env.deployer().update_current_contract_wasm(new_hash)`.' },
];

export default { ProjectWorkspace };
