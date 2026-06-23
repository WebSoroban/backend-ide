/**
 * The agent harness — the server-side tool loop.
 *
 *   send messages + tools  →  model streams tokens/reasoning/tool_calls
 *                          →  execute the tool calls server-side (toolExecutor)
 *                          →  append results  →  repeat until the model stops
 *
 * Mode shapes the loop: which tools are offered (tools.ts), what the system
 * prompt demands (prompts.ts), and — for AGENT/DEBUG — the validation loop
 * (compile/clippy/tests fed back) the system prompt insists on. ASK/PLAN get
 * read-only tools so they physically cannot edit.
 *
 * Streaming + persistence are decoupled: the harness emits live events via the
 * `emit` callback and returns a structured result; the worker persists rows and
 * the final message. The harness never writes to the project — edits are net
 * diffs surfaced for review (diff-review UI), applied only on user accept.
 */
import { streamChat } from './openrouter';
import { resolveRun } from './models';
import { buildSystemPrompt } from './prompts';
import { getToolsForMode } from './tools';
import { ProjectWorkspace } from './toolExecutor';
import { classifyPromptScope, SCOPE_REDIRECT } from './scope';
import { buildSkillContext, parseSkillMentions, type SkillRecord } from './skills';
import { costToCredits } from '../billing/config';
import type { ChatMessage, CopilotMode, ProposedEdit, ToolCallRequest } from './types';

const MAX_ITERATIONS = parseInt(process.env.AI_MAX_TOOL_ITERATIONS || '24', 10);

// Layer 3 — cheap scope pre-check. On by default; set AI_SCOPE_PRECHECK=0 to
// disable (Layers 1+2 still enforce scope). Tuned to short-circuit ONLY prompts
// that are clearly off-domain, so legitimate Rust/Soroban/IDE work is unaffected.
const SCOPE_PRECHECK_ENABLED = process.env.AI_SCOPE_PRECHECK !== '0';

/**
 * The RunOutput for an out-of-scope short-circuit: the standard redirect, with
 * NO tool calls, NO edits, and zero iterations (no agent loop, no model spend).
 * Exported so the redirect-produces-no-artifact guarantee is unit-testable.
 */
export function scopeRedirectOutput(): RunOutput {
  return {
    content: SCOPE_REDIRECT,
    reasoning: '',
    finishReason: 'stop',
    iterations: 0,
    tokensIn: 0,
    tokensOut: 0,
    edits: [],
    toolCalls: [],
    capped: false,
    costUsd: 0,
  };
}

export interface PriorMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
}

export interface RunInput {
  runId: string;
  userId: string;
  mode: CopilotMode;
  model: string;
  maxMode: boolean;
  prompt: string;
  /** Resolved @-context (file excerpts, errors, selection) appended to the prompt. */
  attachedContext?: string;
  project: {
    id: string;
    name: string;
    manifestPath: string;
    deployTarget?: string | null;
    contractAddress?: string | null;
    spec?: { entries?: string[]; functions?: any[] } | null;
    files: { path: string; content: string }[];
  };
  /** Prior thread turns (the thread is mode-pinned, so this is one context window). */
  priorMessages?: PriorMessage[];
  /** Project/user rules applied to every mode. */
  rules?: string;
  /** The user's effective-enabled skills (index always; bodies progressively). */
  skills?: SkillRecord[];
  /**
   * Credits available at run start. When set, the loop stops once the run's actual
   * cost reaches this many credits, so a single run can't massively overspend the
   * remaining balance (a backstop on top of the route-level balance gate).
   * Undefined = unmetered (e.g. a user on a BYO key). 0 means no headroom.
   */
  creditBudget?: number;
  /** Decrypted BYO OpenRouter key, if the user set one. */
  apiKey?: string;
  signal?: AbortSignal;
}

export interface ToolCallRecord {
  callId: string;
  name: string;
  args: any;
  status: 'success' | 'error';
  resultText: string;
  data?: any;
  edit?: ProposedEdit;
}

export interface RunOutput {
  content: string;
  reasoning: string;
  finishReason: string;
  iterations: number;
  tokensIn: number;
  tokensOut: number;
  edits: ProposedEdit[];
  toolCalls: ToolCallRecord[];
  /** For PLAN mode: the final markdown plan. */
  planMarkdown?: string;
  /** True if the loop stopped on the iteration/budget cap rather than the model. */
  capped: boolean;
  /** Actual USD cost across all model calls in the run (from OpenRouter). */
  costUsd: number;
}

export type EmitFn = (type: string, payload: any) => void;

function parseArgs(raw: string): any {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

/** Run one agent execution to completion. */
export async function runAgent(
  input: RunInput,
  emit: EmitFn,
  checkCancelled: () => Promise<boolean> = async () => false
): Promise<RunOutput> {
  // Layer 3: short-circuit clearly off-domain prompts before spinning up the
  // (expensive) agent loop. Ambiguous / in-scope prompts fall through and are
  // handled by the system prompt (Layer 1) and the tool allowlist (Layer 2).
  if (SCOPE_PRECHECK_ENABLED && classifyPromptScope(input.prompt, input.attachedContext) === 'out_of_scope') {
    emit('status', { phase: 'thinking', iteration: 0 });
    emit('token', { delta: SCOPE_REDIRECT });
    emit('status', { phase: 'scope', message: 'Out of scope — redirected.' });
    return scopeRedirectOutput();
  }

  const resolved = resolveRun(input.model, input.maxMode);
  const tools = getToolsForMode(input.mode);

  // Skill context (progressive disclosure): the cheap index goes in the prompt
  // every run; bodies are injected only for always-scope + @skill-mentioned
  // skills (within the token budget); the rest load on demand via load_skill.
  const mentioned = parseSkillMentions(input.prompt, input.attachedContext);
  const skillCtx = buildSkillContext(input.skills || [], mentioned);

  const workspace = new ProjectWorkspace(input.project.files, {
    runId: input.runId,
    projectId: input.project.id,
    userId: input.userId,
    mode: input.mode,
    manifestPath: input.project.manifestPath,
    deployTarget: input.project.deployTarget,
    contractAddress: input.project.contractAddress,
    spec: input.project.spec,
    model: resolved.model,
    apiKey: input.apiKey,
    reasoningEffort: resolved.reasoningEffort,
    signal: input.signal,
    skills: { loadable: skillCtx.loadable, bodies: skillCtx.bodies },
  });

  const system = buildSystemPrompt({
    mode: input.mode,
    projectName: input.project.name,
    fileTree: input.project.files.map((f) => f.path),
    manifestPath: input.project.manifestPath,
    deployTarget: input.project.deployTarget,
    rules: input.rules,
    contractAddress: input.project.contractAddress,
    skills: { index: skillCtx.index, injected: skillCtx.injected, omitted: skillCtx.omitted },
  });

  const userContent = input.attachedContext
    ? `${input.prompt}\n\n<attached-context>\n${input.attachedContext}\n</attached-context>`
    : input.prompt;

  const messages: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of input.priorMessages || []) {
    if (m.role === 'system') continue;
    messages.push({ role: m.role, content: m.content });
  }
  messages.push({ role: 'user', content: userContent });

  const toolCalls: ToolCallRecord[] = [];
  let finalContent = '';
  let reasoningAll = '';
  let finishReason = 'stop';
  let tokensIn = 0;
  let tokensOut = 0;
  let costUsd = 0;
  let iterations = 0;
  let capped = false;

  while (iterations < MAX_ITERATIONS) {
    if (await checkCancelled()) {
      finishReason = 'cancelled';
      break;
    }
    iterations++;
    emit('status', { phase: 'thinking', iteration: iterations });

    const streamed = await streamChat(
      {
        model: resolved.model,
        messages,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? 'auto' : undefined,
        reasoning_effort: resolved.reasoningEffort,
        max_tokens: resolved.maxTokens,
        apiKey: input.apiKey,
        signal: input.signal,
      },
      {
        onToken: (delta) => emit('token', { delta }),
        onReasoning: (delta) => emit('reasoning', { delta }),
        onToolCall: (call: ToolCallRequest) =>
          emit('tool', { phase: 'call', callId: call.id, name: call.function.name, args: parseArgs(call.function.arguments) }),
      }
    );

    tokensIn += streamed.usage.promptTokens;
    tokensOut += streamed.usage.completionTokens;
    costUsd += streamed.usage.costUsd;
    if (streamed.content) finalContent = streamed.content;
    if (streamed.reasoning) reasoningAll += (reasoningAll ? '\n' : '') + streamed.reasoning;
    finishReason = streamed.finishReason;

    // Record the assistant turn (with any tool calls) for the next round.
    const assistantTurn: ChatMessage = { role: 'assistant', content: streamed.content || null };
    if (streamed.toolCalls.length) assistantTurn.tool_calls = streamed.toolCalls;
    messages.push(assistantTurn);

    // No tool calls → the model produced its final answer.
    if (!streamed.toolCalls.length) break;

    // Execute each tool call, append its result, stream a tool step.
    for (const call of streamed.toolCalls) {
      const args = parseArgs(call.function.arguments);
      const result = await workspace.execute(call.function.name, args);
      const record: ToolCallRecord = {
        callId: call.id,
        name: call.function.name,
        args,
        status: result.ok ? 'success' : 'error',
        resultText: result.content,
        data: result.data,
        edit: result.edit,
      };
      toolCalls.push(record);
      emit('tool', {
        phase: 'result',
        callId: call.id,
        name: call.function.name,
        ok: result.ok,
        summary: result.content.slice(0, 600),
        data: result.data,
        edit: result.edit,
      });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.content.slice(0, 12000) });
    }

    // Per-run output-token budget (MAX Mode widens it).
    if (tokensOut >= resolved.tokenBudget) {
      capped = true;
      emit('status', { phase: 'budget', message: 'Token budget reached — stopping.' });
      break;
    }

    // Credit overspend guard: stop once the run's ACTUAL cost has consumed the
    // user's available credits, so a single run can't run the balance deep
    // negative. Skipped when creditBudget is undefined (e.g. BYO-key users).
    if (input.creditBudget !== undefined && costToCredits(costUsd) >= input.creditBudget) {
      capped = true;
      emit('status', { phase: 'budget', message: 'Credit budget reached — stopping this run.' });
      break;
    }
  }

  if (iterations >= MAX_ITERATIONS && finishReason === 'tool_calls') {
    capped = true;
    emit('status', { phase: 'capped', message: `Reached max ${MAX_ITERATIONS} tool iterations.` });
  }

  const edits = workspace.netEdits();
  const out: RunOutput = {
    content: finalContent,
    reasoning: reasoningAll,
    finishReason,
    iterations,
    tokensIn,
    tokensOut,
    edits,
    toolCalls,
    capped,
    costUsd,
  };
  if (input.mode === 'plan') out.planMarkdown = finalContent;
  return out;
}

export default { runAgent };
