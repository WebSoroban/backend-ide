/**
 * Model registry for the Copilot model switcher.
 *
 * Curates a coding-focused subset of OpenRouter's catalog (Claude, GPT, Gemini,
 * DeepSeek, Qwen, …) plus an "Auto" routing option, enriches each entry with the
 * live catalog (context length, pricing, availability), and exposes a clean list
 * to the frontend. It also resolves a user's (model + MAX-mode) choice into the
 * concrete request knobs the harness sends to OpenRouter: reasoning_effort and a
 * per-run token budget.
 *
 * Pricing/keys are never exposed beyond what OpenRouter already publishes
 * publicly on /models; the API key itself stays server-side.
 */
import { listModels, type OpenRouterModel } from './openrouter';
import type { ReasoningEffort } from './types';

export const AUTO_MODEL_ID = process.env.AI_DEFAULT_MODEL || 'openrouter/auto';

const RUN_TOKEN_BUDGET = parseInt(process.env.AI_RUN_TOKEN_BUDGET || '120000', 10);
const MAX_MODE_TOKEN_BUDGET = parseInt(process.env.AI_MAX_MODE_TOKEN_BUDGET || '400000', 10);
const MAX_OUTPUT_TOKENS = parseInt(process.env.AI_MAX_OUTPUT_TOKENS || '8000', 10);

export type EffortLabel = 'High' | 'Medium' | 'Fast';

export interface CuratedModel {
  /** OpenRouter model slug, e.g. "anthropic/claude-opus-4.8". */
  id: string;
  label: string;
  vendor: string;
  /** Default reasoning-effort label shown next to the model. */
  effort: EffortLabel;
  /** Whether the model exposes a reasoning/thinking budget. */
  reasoning: boolean;
  recommended?: boolean;
  /** Short tagline for the switcher. */
  blurb?: string;
}

/**
 * The hand-picked default list. Slugs are the stable OpenRouter ids; if a slug
 * isn't currently available it's simply filtered out after the live fetch, and
 * the user can still pick any model via "Add Models" (the full catalog).
 */
const CURATED: CuratedModel[] = [
  {
    id: AUTO_MODEL_ID,
    label: 'Auto',
    // Neutral — never surface the underlying routing provider in the UI.
    vendor: 'Auto',
    effort: 'Medium',
    reasoning: false,
    recommended: true,
    blurb: 'Automatically picks the best model for the task',
  },
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8', vendor: 'Anthropic', effort: 'High', reasoning: true, recommended: true, blurb: 'Top-tier reasoning for hard contract work' },
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6', vendor: 'Anthropic', effort: 'Medium', reasoning: true, recommended: true, blurb: 'Fast, strong default for agentic edits' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', vendor: 'Anthropic', effort: 'Fast', reasoning: true, blurb: 'Quick fixes and explanations' },
  { id: 'openai/gpt-5.1', label: 'GPT-5.1', vendor: 'OpenAI', effort: 'High', reasoning: true, blurb: 'Strong reasoning + tool use' },
  { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini', vendor: 'OpenAI', effort: 'Fast', reasoning: true, blurb: 'Cheap and fast' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', vendor: 'Google', effort: 'High', reasoning: true, blurb: 'Huge context window' },
  { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', vendor: 'Google', effort: 'Fast', reasoning: true, blurb: 'Low-latency edits' },
  { id: 'deepseek/deepseek-chat-v3.1', label: 'DeepSeek V3.1', vendor: 'DeepSeek', effort: 'Medium', reasoning: false, blurb: 'Strong open coding model' },
  { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1', vendor: 'DeepSeek', effort: 'High', reasoning: true, blurb: 'Open reasoning model' },
  { id: 'qwen/qwen3-coder', label: 'Qwen3 Coder', vendor: 'Qwen', effort: 'Medium', reasoning: false, blurb: 'Code-specialized' },
  { id: 'x-ai/grok-code-fast-1', label: 'Grok Code Fast', vendor: 'xAI', effort: 'Fast', reasoning: false, blurb: 'Fast agentic coding' },
];

const EFFORT_TO_ENUM: Record<EffortLabel, ReasoningEffort> = { High: 'high', Medium: 'medium', Fast: 'low' };

export interface RegistryModel extends CuratedModel {
  available: boolean;
  contextLength?: number;
  pricing?: { prompt?: string; completion?: string };
}

export interface ModelRegistry {
  models: RegistryModel[];
  /** The full live catalog (id + name + context) for the "Add Models" search. */
  catalog: { id: string; name: string; contextLength?: number }[];
  fetchedAt: number;
}

let cache: ModelRegistry | null = null;
let cacheAt = 0;
const TTL_MS = 10 * 60 * 1000;

/** Build (and cache) the curated registry, enriched from the live catalog. */
export async function getRegistry(force = false): Promise<ModelRegistry> {
  if (!force && cache && Date.now() - cacheAt < TTL_MS) return cache;

  let live: OpenRouterModel[] = [];
  try {
    live = await listModels();
  } catch (e: any) {
    // Offline / no key: still return the curated list (marked unavailable).
    console.warn('[ai/models] live catalog fetch failed:', e.message);
  }

  const byId = new Map(live.map((m) => [m.id, m]));

  const models: RegistryModel[] = CURATED.map((c) => {
    const m = byId.get(c.id);
    // "Auto" is always available when any key is configured.
    const available = c.id === AUTO_MODEL_ID ? live.length > 0 || !!process.env.OPENROUTER_API_KEY : !!m;
    return {
      ...c,
      available,
      contextLength: m?.context_length,
      pricing: m?.pricing,
    };
  });

  const catalog = live
    .map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.context_length }))
    .sort((a, b) => a.name.localeCompare(b.name));

  cache = { models, catalog, fetchedAt: Date.now() };
  cacheAt = Date.now();
  return cache;
}

/** Whether a model id is the Auto router. */
export function isAuto(modelId: string): boolean {
  return modelId === AUTO_MODEL_ID || modelId === 'auto';
}

export interface ResolvedRun {
  model: string;
  reasoningEffort: ReasoningEffort;
  /** per-run output-token budget (sum across all model turns) */
  tokenBudget: number;
  /** per-turn max_tokens */
  maxTokens: number;
}

/**
 * Resolve a (model, maxMode) choice into concrete request knobs. MAX Mode raises
 * the reasoning effort to "high" and widens the per-run token budget.
 */
export function resolveRun(modelId: string | null | undefined, maxMode: boolean): ResolvedRun {
  const id = modelId && modelId.trim() ? modelId.trim() : AUTO_MODEL_ID;
  const curated = CURATED.find((c) => c.id === id);
  const baseEffort: ReasoningEffort = curated ? EFFORT_TO_ENUM[curated.effort] : 'medium';
  return {
    model: isAuto(id) ? AUTO_MODEL_ID : id,
    reasoningEffort: maxMode ? 'high' : baseEffort,
    tokenBudget: maxMode ? MAX_MODE_TOKEN_BUDGET : RUN_TOKEN_BUDGET,
    maxTokens: MAX_OUTPUT_TOKENS,
  };
}

export default { getRegistry, resolveRun, isAuto, AUTO_MODEL_ID };
