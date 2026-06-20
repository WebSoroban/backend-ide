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
import type { ChatMessage, CopilotMode, ProposedEdit, ToolCallRequest } from './types';

const MAX_ITERATIONS = parseInt(process.env.AI_MAX_TOOL_ITERATIONS || '24', 10);

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
  const resolved = resolveRun(input.model, input.maxMode);
  const tools = getToolsForMode(input.mode);

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
  });

  const system = buildSystemPrompt({
    mode: input.mode,
    projectName: input.project.name,
    fileTree: input.project.files.map((f) => f.path),
    manifestPath: input.project.manifestPath,
    deployTarget: input.project.deployTarget,
    rules: input.rules,
    contractAddress: input.project.contractAddress,
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
  };
  if (input.mode === 'plan') out.planMarkdown = finalContent;
  return out;
}

export default { runAgent };
