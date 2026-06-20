/**
 * Shared types for the AI Copilot subsystem.
 *
 * The wire format is OpenAI-compatible (OpenRouter speaks the same dialect), so
 * messages/tools mirror the OpenAI Chat Completions shapes. Everything here is
 * server-side only — keys and raw provider payloads never reach the browser.
 */

/** The five Copilot modes. Each starts a fresh context window. */
export type CopilotMode = 'ask' | 'agent' | 'plan' | 'debug' | 'multitask';

export const COPILOT_MODES: CopilotMode[] = ['ask', 'agent', 'plan', 'debug', 'multitask'];

export type ReasoningEffort = 'low' | 'medium' | 'high';

/** A chat message in the OpenAI tool-calling format. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** assistant turns may carry tool calls */
  tool_calls?: ToolCallRequest[];
  /** tool results reference the call they answer */
  tool_call_id?: string;
  name?: string;
}

export interface ToolCallRequest {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A JSON-schema tool definition (OpenAI "function" tool). */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  tool_choice?: 'auto' | 'none' | 'required';
  parallel_tool_calls?: boolean;
  reasoning_effort?: ReasoningEffort;
  response_format?: { type: 'json_object' | 'text' };
  max_tokens?: number;
  temperature?: number;
  /** Per-user BYO key (already decrypted). Falls back to the server key. */
  apiKey?: string;
  /** Abort the in-flight request (run cancellation). */
  signal?: AbortSignal;
}

/** Normalized finish reason across providers. */
export type FinishReason = 'tool_calls' | 'stop' | 'length' | 'content_filter' | 'error' | 'unknown';

export interface StreamCallbacks {
  /** Visible assistant text delta. */
  onToken?: (delta: string) => void;
  /** Reasoning / chain-of-thought delta (collapsible in the UI). */
  onReasoning?: (delta: string) => void;
  /** A tool call has finished accumulating its name + arguments. */
  onToolCall?: (call: ToolCallRequest) => void;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCallRequest[];
  finishReason: FinishReason;
  usage: TokenUsage;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** A proposed file edit, surfaced to the diff-review UI (never auto-written silently). */
export interface ProposedEdit {
  /** create | modify | delete */
  op: 'create' | 'modify' | 'delete';
  path: string;
  /** new full file content (absent for delete) */
  content?: string;
  /** previous content (absent for create) — lets the UI rebuild either side */
  previousContent?: string;
  /** unified diff text for display */
  diff: string;
}

/** A security finding from run_security_audit. */
export interface SecurityFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  rule: string;
  title: string;
  file?: string;
  line?: number;
  detail: string;
  suggestedFix: string;
}
