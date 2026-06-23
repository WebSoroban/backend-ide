/**
 * Skills — user-authored (or OFFICIAL) Soroban/Stellar knowledge + instruction
 * packs the Copilot loads as CONTEXT, with progressive disclosure so it stays
 * token-efficient:
 *
 *   - INDEX (name + description + whenToUse) → injected every run (cheap).
 *   - BODY → loaded on demand: injected every run for scope="always", pulled via
 *     the load_skill tool for scope="auto" when the task matches whenToUse, and
 *     force-loaded when the user @skill:<slug>-mentions it (any scope).
 *
 * GUARDRAIL BOUNDARY: skill bodies are GUIDANCE/DATA, never authority. They can
 * shape HOW contracts are written but cannot widen the Soroban-only scope, the
 * file-type allowlist, or the secret/deploy/safety rules. This module:
 *   - validates skill content on save (in-domain + no role override),
 *   - frames injected bodies as untrusted reference (the prompt does the rest),
 *   - caps the total skill tokens injected per run.
 *
 * The pure helpers (validate / build context / parse mentions / slug) have no I/O
 * so they are unit-testable; getActiveSkillsForUser is the only DB-touching call.
 */
import prisma from '../../lib/prisma';
import { classifyPromptScope, containsRoleOverride } from './scope';

export type SkillScope = 'always' | 'auto' | 'manual';
export type SkillVisibility = 'private' | 'public';

/** The fields the context pipeline needs (a row projected for a run). */
export interface SkillRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  whenToUse: string;
  body: string;
  scope: SkillScope;
  official: boolean;
}

// Total tokens of skill BODY injected into a single run's system prompt
// (index lines are tiny and excluded from this cap). ~4 chars/token heuristic.
export const SKILL_TOKEN_BUDGET = parseInt(process.env.AI_SKILL_TOKEN_BUDGET || '6000', 10);
// Defensive caps on a single skill's stored fields (also enforced by validate).
export const MAX_SKILL_BODY_CHARS = 24000;
const MAX_INDEX_SKILLS = 60;

/** Cheap token estimate (chars / 4). */
export function estimateTokens(s: string): number {
  return Math.ceil((s || '').length / 4);
}

/** Normalize a free-text name/handle into a stable @skill / load_skill slug. */
export function normalizeSlug(input: string): string {
  return (input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

// ---------------------------------------------------------------------------
// Validation on save — a skill may shape HOW contracts are written, not turn the
// Copilot into a general-purpose / off-domain assistant, and not jailbreak it.
// ---------------------------------------------------------------------------

export interface SkillInput {
  name?: string;
  description?: string;
  whenToUse?: string;
  body?: string;
  scope?: string;
  visibility?: string;
}

export interface SkillValidation {
  ok: boolean;
  /** Present when ok === false. */
  reason?: string;
  /** Normalized, safe-to-store fields when ok === true. */
  value?: {
    name: string;
    slug: string;
    description: string;
    whenToUse: string;
    body: string;
    scope: SkillScope;
    visibility: SkillVisibility;
  };
}

const SCOPES: SkillScope[] = ['always', 'auto', 'manual'];

export function validateSkill(input: SkillInput): SkillValidation {
  const name = (input.name || '').trim();
  if (!name) return { ok: false, reason: 'A skill needs a name.' };
  if (name.length > 80) return { ok: false, reason: 'Name is too long (max 80 chars).' };

  const slug = normalizeSlug(name);
  if (!slug) return { ok: false, reason: 'Name must contain letters or numbers.' };

  const description = (input.description || '').trim().slice(0, 280);
  const whenToUse = (input.whenToUse || '').trim().slice(0, 400);
  const body = (input.body || '').trim();
  if (!body) return { ok: false, reason: 'A skill needs a body (the guidance/patterns).' };
  if (body.length > MAX_SKILL_BODY_CHARS) {
    return { ok: false, reason: `Body is too long (max ${MAX_SKILL_BODY_CHARS} chars).` };
  }

  const scope: SkillScope = SCOPES.includes(input.scope as SkillScope) ? (input.scope as SkillScope) : 'auto';
  const visibility: SkillVisibility = input.visibility === 'public' ? 'public' : 'private';

  // GUARDRAIL 1 — no role/scope subversion anywhere in the authored content.
  const combined = `${name}\n${description}\n${whenToUse}\n${body}`;
  if (containsRoleOverride(combined)) {
    return {
      ok: false,
      reason:
        'A skill cannot redefine the assistant or remove its limits. Skills shape HOW Soroban contracts are written — they cannot make the Copilot a general-purpose assistant or override its scope/safety rules.',
    };
  }

  // GUARDRAIL 2 — must stay in the Soroban/Stellar/Rust domain. The classifier
  // only rejects content with a clear off-domain signal AND no in-domain anchor,
  // so a normal Rust/Soroban pattern (even with a stray English word) passes.
  if (classifyPromptScope(`${description} ${whenToUse} ${body}`) === 'out_of_scope') {
    return {
      ok: false,
      reason:
        'This skill looks off-domain. Skills must be about Soroban/Stellar smart contracts (Rust) — e.g. a token pattern, auth/storage convention, or testing style.',
    };
  }

  return { ok: true, value: { name, slug, description, whenToUse, body, scope, visibility } };
}

// ---------------------------------------------------------------------------
// Mentions — @skill:<slug> in the prompt / attached context force-loads a body.
// ---------------------------------------------------------------------------

const MENTION_RE = /@skill:([a-z0-9][a-z0-9-]{0,63})/gi;

/** Extract the set of @skill:<slug> handles referenced in the given text(s). */
export function parseSkillMentions(...texts: (string | undefined | null)[]): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    let m: RegExpExecArray | null;
    MENTION_RE.lastIndex = 0;
    while ((m = MENTION_RE.exec(t)) !== null) {
      found.add(m[1].toLowerCase());
    }
  }
  return [...found];
}

// ---------------------------------------------------------------------------
// Context assembly (pure) — what the prompt + load_skill tool consume.
// ---------------------------------------------------------------------------

export interface SkillContext {
  /** Cheap always-on index (name + description + whenToUse + scope) for every enabled skill. */
  index: string;
  /** Full bodies injected this run (always-scope + @-mentioned), within budget. */
  injected: { slug: string; name: string; body: string }[];
  /** Slugs whose body the load_skill tool may return this run (always/auto + mentioned). */
  loadable: Set<string>;
  /** slug → { name, body } for every enabled skill (the tool reads from here). */
  bodies: Map<string, { name: string; body: string }>;
  /** Bodies that scope/mention asked to inject but were dropped for the token budget. */
  omitted: string[];
}

/**
 * Build the per-run skill context from a user's enabled skills.
 *
 * @param skills        the user's EFFECTIVE-ENABLED skill set (see getActiveSkillsForUser)
 * @param mentionedSlugs slugs the user @skill-mentioned this turn (force-loaded)
 * @param tokenBudget   max BODY tokens to inject (always + mentioned)
 */
export function buildSkillContext(
  skills: SkillRecord[],
  mentionedSlugs: string[] = [],
  tokenBudget: number = SKILL_TOKEN_BUDGET
): SkillContext {
  const mentioned = new Set(mentionedSlugs.map((s) => s.toLowerCase()));
  const bodies = new Map<string, { name: string; body: string }>();
  const loadable = new Set<string>();

  // Index (bounded) + the tool's loadable set.
  const indexLines: string[] = [];
  for (const s of skills.slice(0, MAX_INDEX_SKILLS)) {
    bodies.set(s.slug, { name: s.name, body: s.body });
    // load_skill may pull always/auto bodies anytime; manual only if mentioned.
    if (s.scope !== 'manual' || mentioned.has(s.slug)) loadable.add(s.slug);
    const when = s.whenToUse ? ` — use when: ${s.whenToUse}` : '';
    const tag = s.scope === 'always' ? ' [always-on]' : s.scope === 'manual' ? ' [manual — @skill to load]' : '';
    indexLines.push(`- @skill:${s.slug} — ${s.name}: ${s.description || '(no description)'}${when}${tag}`);
  }

  // Bodies to inject this run: @-mentioned first (explicit user intent), then
  // every always-scope skill. Dedup, then fill up to the token budget.
  const wantInject: SkillRecord[] = [];
  const seen = new Set<string>();
  for (const s of skills) {
    if (mentioned.has(s.slug) && !seen.has(s.slug)) { wantInject.push(s); seen.add(s.slug); }
  }
  for (const s of skills) {
    if (s.scope === 'always' && !seen.has(s.slug)) { wantInject.push(s); seen.add(s.slug); }
  }

  const injected: { slug: string; name: string; body: string }[] = [];
  const omitted: string[] = [];
  let spent = 0;
  for (const s of wantInject) {
    const cost = estimateTokens(s.body);
    if (spent + cost > tokenBudget && injected.length > 0) {
      omitted.push(s.slug);
      continue;
    }
    injected.push({ slug: s.slug, name: s.name, body: s.body });
    loadable.add(s.slug); // an injected manual mention is also tool-loadable
    spent += cost;
  }

  return { index: indexLines.join('\n'), injected, loadable, bodies, omitted };
}

// ---------------------------------------------------------------------------
// Effective skill set for a user (the only DB call). Personal enabled skills +
// official/public skills not turned off in SkillPreference. Private skills never
// leak across users (owner-scoped query).
// ---------------------------------------------------------------------------

export async function getActiveSkillsForUser(userId: string): Promise<SkillRecord[]> {
  const [own, official, prefs] = await Promise.all([
    prisma.skill.findMany({ where: { ownerId: userId } }),
    prisma.skill.findMany({ where: { official: true } }),
    prisma.skillPreference.findMany({ where: { userId } }),
  ]);

  const prefById = new Map(prefs.map((p) => [p.skillId, p.enabled]));

  // Public skills from OTHER users are opt-in: only loaded when the user has an
  // enabled preference for them (browsing the library writes that preference).
  const optInIds = prefs.filter((p) => p.enabled).map((p) => p.skillId);
  const optInPublic = optInIds.length
    ? await prisma.skill.findMany({
        where: { id: { in: optInIds }, visibility: 'public', official: false, NOT: { ownerId: userId } },
      })
    : [];

  const active: SkillRecord[] = [];
  const pushed = new Set<string>();

  const project = (s: (typeof own)[number]): SkillRecord => ({
    id: s.id,
    slug: s.slug,
    name: s.name,
    description: s.description,
    whenToUse: s.whenToUse,
    body: s.body,
    scope: (SCOPES.includes(s.scope as SkillScope) ? s.scope : 'auto') as SkillScope,
    official: s.official,
  });

  // Personal skills: the owner's own Skill.enabled column is the source of truth.
  for (const s of own) {
    if (s.enabled && !pushed.has(s.id)) { active.push(project(s)); pushed.add(s.id); }
  }
  // Official skills: enabled-by-default unless the user turned them off (pref).
  for (const s of official) {
    if (pushed.has(s.id)) continue; // an official skill is never owned by a user
    const enabled = prefById.has(s.id) ? prefById.get(s.id)! : s.enabled;
    if (enabled) { active.push(project(s)); pushed.add(s.id); }
  }
  // Opted-in public skills from other users.
  for (const s of optInPublic) {
    if (!pushed.has(s.id)) { active.push(project(s)); pushed.add(s.id); }
  }

  return active;
}

export default {
  estimateTokens,
  normalizeSlug,
  validateSkill,
  parseSkillMentions,
  buildSkillContext,
  getActiveSkillsForUser,
  SKILL_TOKEN_BUDGET,
};
