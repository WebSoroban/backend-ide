/**
 * OpenRouter client (OpenAI-compatible Chat Completions).
 *
 * SERVER-SIDE ONLY. The API key — the shared OPENROUTER_API_KEY or a user's
 * decrypted BYO key — never leaves this process and is never logged or returned.
 *
 * Two entry points:
 *   - streamChat()  : streams tokens + reasoning + tool calls (the agent loop).
 *   - completeChat(): one-shot JSON/text completion (security audit, titles).
 *
 * Plus listModels() to fetch OpenRouter's catalog for the model registry.
 *
 * We forward HTTP-Referer / X-Title so usage is attributed in the OpenRouter
 * dashboard, and normalize finish_reason across providers.
 */
import type {
  ChatCompletionOptions,
  FinishReason,
  StreamCallbacks,
  StreamResult,
  ToolCallRequest,
  TokenUsage,
} from './types';

const BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const SITE_URL = process.env.OPENROUTER_SITE_URL || 'https://websoroban.in';
const APP_NAME = process.env.OPENROUTER_APP_NAME || 'WebSoroban Copilot';

export class OpenRouterError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
  }
}

/** Resolve the key to use: per-user BYO (passed in) else the shared server key. */
function resolveKey(apiKey?: string): string {
  const key = apiKey || process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new OpenRouterError(
      'OpenRouter is not configured. Set OPENROUTER_API_KEY (or add your own key in Copilot settings).',
      503
    );
  }
  return key;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    // OpenRouter attribution headers.
    'HTTP-Referer': SITE_URL,
    'X-Title': APP_NAME,
  };
}

/** Map any provider finish_reason onto our normalized enum. */
export function normalizeFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'stop':
    case 'end_turn':
    case 'eos':
      return 'stop';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    case null:
    case undefined:
    case '':
      return 'unknown';
    default:
      return 'unknown';
  }
}

function buildBody(opts: ChatCompletionOptions, stream: boolean) {
  const body: Record<string, any> = {
    model: opts.model,
    messages: opts.messages,
    stream,
  };
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.tool_choice || 'auto';
    // Keep tool calls sequential by default so the harness can checkpoint each
    // edit; callers may opt into parallel calls for read-only fan-out.
    body.parallel_tool_calls = opts.parallel_tool_calls ?? false;
  }
  if (opts.reasoning_effort) {
    // OpenRouter normalizes `reasoning` across providers (effort -> thinking budget).
    body.reasoning = { effort: opts.reasoning_effort };
  }
  if (opts.response_format) body.response_format = opts.response_format;
  if (opts.max_tokens) body.max_tokens = opts.max_tokens;
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
  if (stream) body.usage = { include: true }; // ask OpenRouter to stream a usage chunk
  return body;
}

const EMPTY_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

function parseUsage(usage: any): TokenUsage {
  if (!usage) return { ...EMPTY_USAGE };
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
  };
}

/**
 * Stream a chat completion. Invokes the callbacks as tokens/reasoning/tool calls
 * arrive and resolves with the fully-assembled result once the stream ends.
 */
export async function streamChat(
  opts: ChatCompletionOptions,
  cb: StreamCallbacks = {}
): Promise<StreamResult> {
  const apiKey = resolveKey(opts.apiKey);
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(buildBody(opts, true)),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new OpenRouterError(`OpenRouter error ${res.status}: ${truncate(text)}`, res.status || 502);
  }

  let content = '';
  let reasoning = '';
  let finishReason: FinishReason = 'unknown';
  let usage: TokenUsage = { ...EMPTY_USAGE };
  // tool calls arrive as indexed deltas that must be stitched together
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();

  const decoder = new TextDecoder();
  let buffer = '';

  // Node's fetch body is an async-iterable web ReadableStream.
  for await (const chunk of res.body as any) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line || line.startsWith(':')) continue; // SSE comment / keepalive
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;

      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue; // partial frame; ignore (next loop reassembles)
      }

      if (json.usage) usage = parseUsage(json.usage);
      const choice = json.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        content += delta.content;
        cb.onToken?.(delta.content);
      }
      // OpenRouter exposes reasoning as `reasoning` (string) on the delta.
      const r = delta.reasoning ?? delta.reasoning_content;
      if (typeof r === 'string' && r) {
        reasoning += r;
        cb.onReasoning?.(r);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const cur = toolAcc.get(idx) || { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          toolAcc.set(idx, cur);
        }
      }
      if (choice.finish_reason) finishReason = normalizeFinishReason(choice.finish_reason);
    }
  }

  const toolCalls: ToolCallRequest[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => ({
      id: t.id || `call_${Math.abs(hash(t.name + t.args))}`,
      type: 'function' as const,
      function: { name: t.name, arguments: t.args || '{}' },
    }))
    .filter((t) => t.function.name);

  for (const t of toolCalls) cb.onToolCall?.(t);

  // If the model emitted tool calls but the provider didn't tag the reason.
  if (toolCalls.length && finishReason !== 'length') finishReason = 'tool_calls';

  return { content, reasoning, toolCalls, finishReason, usage };
}

/** One-shot (non-streaming) completion. Used for audits, titles, quick JSON. */
export async function completeChat(opts: ChatCompletionOptions): Promise<StreamResult> {
  const apiKey = resolveKey(opts.apiKey);
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: headers(apiKey),
    body: JSON.stringify(buildBody(opts, false)),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new OpenRouterError(`OpenRouter error ${res.status}: ${truncate(text)}`, res.status || 502);
  }
  const json: any = await res.json();
  const choice = json.choices?.[0] || {};
  const msg = choice.message || {};
  const toolCalls: ToolCallRequest[] = Array.isArray(msg.tool_calls)
    ? msg.tool_calls.map((t: any) => ({
        id: t.id,
        type: 'function' as const,
        function: { name: t.function?.name, arguments: t.function?.arguments || '{}' },
      }))
    : [];
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    reasoning: typeof msg.reasoning === 'string' ? msg.reasoning : '',
    toolCalls,
    finishReason: normalizeFinishReason(choice.finish_reason),
    usage: parseUsage(json.usage),
  };
}

export interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[]; modality?: string };
  supported_parameters?: string[];
}

/** Fetch the full OpenRouter model catalog (curated downstream in models.ts). */
export async function listModels(apiKey?: string): Promise<OpenRouterModel[]> {
  const key = process.env.OPENROUTER_API_KEY || apiKey;
  const res = await fetch(`${BASE_URL}/models`, {
    headers: key ? headers(key) : { 'HTTP-Referer': SITE_URL, 'X-Title': APP_NAME },
  });
  if (!res.ok) {
    throw new OpenRouterError(`Failed to fetch models (${res.status})`, res.status || 502);
  }
  const json: any = await res.json();
  return Array.isArray(json.data) ? json.data : [];
}

function truncate(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

export default { streamChat, completeChat, listModels, normalizeFinishReason };
