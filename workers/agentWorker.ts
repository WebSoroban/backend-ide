import 'dotenv/config';
import type { Job } from 'bullmq';
import { createWorker, AGENT_QUEUE_NAME } from '../queues/bullmq';
import socketService from '../services/socketService';
import prisma from '../lib/prisma';
import { decrypt } from '../lib/crypto';
import { runAgent, type PriorMessage, type RunInput } from '../services/ai/harness';
import { completeChat } from '../services/ai/openrouter';
import type { CopilotMode } from '../services/ai/types';
import { initObservability, captureError } from '../lib/observability';

// Workers don't own the Socket.IO instance — init pub/sub so emitRunEvent works.
socketService.init(null);
initObservability();

const AGENT_WORKER_CONCURRENCY = parseInt(process.env.AGENT_WORKER_CONCURRENCY || '4', 10);

/** Files the harness reads from for project/user rules (first match wins). */
const RULES_FILES = ['.websoroban/rules.md', 'COPILOT_RULES.md', 'AGENTS.md', '.cursorrules'];

async function processAgentJob(job: Job) {
  const { runId } = job.data as { runId: string };
  console.log(`[AgentWorker] Processing run ${runId}`);

  const run = await prisma.agentRun.findUnique({ where: { id: runId } });
  if (!run) {
    console.warn(`[AgentWorker] Run ${runId} not found`);
    return;
  }
  if (run.status === 'cancelled') {
    socketService.emitRunEvent(runId, 'status', { phase: 'cancelled' });
    return;
  }

  const emit = (type: string, payload: any) => socketService.emitRunEvent(runId, type, payload);

  try {
    // Load the project + files.
    const project = run.projectId
      ? await prisma.project.findUnique({
          where: { id: run.projectId },
          include: { files: { select: { path: true, content: true } } },
        })
      : null;
    if (!project) throw new Error('Project not found for this run.');

    const files = project.files.map((f) => ({ path: f.path, content: f.content }));

    // Checkpoint the pre-run tree so the whole run can be undone.
    await prisma.agentRun.update({
      where: { id: runId },
      data: { status: 'running', checkpoint: { files } as any },
    });
    emit('status', { phase: 'running' });

    // Thread history (the thread is mode-pinned → one context window). The most
    // recent user message is the current prompt; everything before is prior.
    let priorMessages: PriorMessage[] = [];
    let attachedContext: string | undefined;
    if (run.threadId) {
      const msgs = await prisma.chatMessage.findMany({
        where: { threadId: run.threadId },
        orderBy: { createdAt: 'asc' },
      });
      let lastUserIdx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'user') {
          lastUserIdx = i;
          break;
        }
      }
      if (lastUserIdx >= 0) {
        const meta = (msgs[lastUserIdx].meta as any) || {};
        attachedContext = typeof meta.context === 'string' ? meta.context : undefined;
      }
      priorMessages = msgs
        .filter((_, i) => i !== lastUserIdx)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    }

    // Project/user rules from a conventional file, if present.
    const rulesFile = files.find((f) => RULES_FILES.includes(f.path));
    const rules = rulesFile?.content;

    // Per-user BYO OpenRouter key (decrypted just-in-time; never logged).
    let apiKey: string | undefined;
    const setting = await prisma.aiSetting.findUnique({ where: { userId: run.userId } });
    if (setting?.openRouterKeyEncrypted) {
      try {
        apiKey = decrypt(setting.openRouterKeyEncrypted);
      } catch (e: any) {
        console.warn('[AgentWorker] Could not decrypt BYO key:', e.message);
      }
    }

    const input: RunInput = {
      runId,
      userId: run.userId,
      mode: run.mode as CopilotMode,
      model: run.model,
      maxMode: run.maxMode,
      prompt: run.prompt,
      attachedContext,
      project: {
        id: project.id,
        name: project.name,
        manifestPath: project.manifestPath,
        deployTarget: project.deployTarget,
        contractAddress: project.contractAddress,
        spec: project.spec as any,
        files,
      },
      priorMessages,
      rules,
    };

    // First turn → generate a short AI title for the conversation tab, persist it,
    // and stream it (`title` event) so the tab label updates live.
    let aiTitle: string | undefined;
    if (run.threadId && priorMessages.length === 0) {
      aiTitle = await generateTitle(run.prompt, run.model, apiKey);
      await prisma.chatThread.update({ where: { id: run.threadId }, data: { title: aiTitle } }).catch(() => {});
      emit('title', { title: aiTitle });
    }

    const checkCancelled = async () => {
      const fresh = await prisma.agentRun.findUnique({ where: { id: runId }, select: { status: true } });
      return fresh?.status === 'cancelled';
    };

    const out = await runAgent(input, emit, checkCancelled);

    if (out.finishReason === 'cancelled') {
      await prisma.agentRun.update({ where: { id: runId }, data: { status: 'cancelled' } });
      emit('status', { phase: 'cancelled' });
      return;
    }

    // Persist the assistant message + its tool calls + the run result.
    let planId: string | undefined;
    if (run.mode === 'plan' && out.planMarkdown && run.threadId) {
      const plan = await prisma.plan.create({
        data: {
          userId: run.userId,
          projectId: run.projectId,
          threadId: run.threadId,
          title: deriveTitle(run.prompt) || 'Implementation Plan',
          content: out.planMarkdown,
          status: 'ready',
        },
      });
      planId = plan.id;
    }

    let assistantMessageId: string | undefined;
    if (run.threadId) {
      const assistant = await prisma.chatMessage.create({
        data: {
          threadId: run.threadId,
          userId: run.userId,
          role: 'assistant',
          content: out.content,
          reasoning: out.reasoning || null,
          meta: {
            runId,
            model: run.model,
            finishReason: out.finishReason,
            tokensIn: out.tokensIn,
            tokensOut: out.tokensOut,
            iterations: out.iterations,
            editCount: out.edits.length,
            planId,
          } as any,
        },
      });
      assistantMessageId = assistant.id;

      if (out.toolCalls.length) {
        await prisma.toolCall.createMany({
          data: out.toolCalls.map((tc) => ({
            runId,
            messageId: assistant.id,
            callId: tc.callId,
            name: tc.name,
            args: tc.args as any,
            result: { text: tc.resultText, data: tc.data ?? null } as any,
            status: tc.status,
            diff: tc.edit ? (tc.edit as any) : undefined,
          })),
        });
      }

      // The thread title is set on the first turn (AI-generated above); just
      // bump updatedAt so it sorts to the top of the history.
      await prisma.chatThread.update({
        where: { id: run.threadId },
        data: { updatedAt: new Date() },
      });
    }

    await prisma.agentRun.update({
      where: { id: runId },
      data: {
        status: 'completed',
        diffs: out.edits as any,
        result: { content: out.content, finishReason: out.finishReason, capped: out.capped, planId } as any,
        tokensIn: out.tokensIn,
        tokensOut: out.tokensOut,
        iterations: out.iterations,
      },
    });

    emit('status', {
      phase: 'done',
      messageId: assistantMessageId,
      edits: out.edits,
      editCount: out.edits.length,
      planId,
      capped: out.capped,
      title: aiTitle, // carry the AI title on done too (covers any early-event race)
    });

    await maybeFinalizeParent(run.parentRunId);
    console.log(`[AgentWorker] Run ${runId} completed (${out.iterations} iters, ${out.edits.length} edits)`);
  } catch (error: any) {
    captureError(error, { worker: 'agent', runId });
    await prisma.agentRun
      .update({ where: { id: runId }, data: { status: 'failed', error: error.message } })
      .catch(() => {});
    emit('error', { message: error.message });
    emit('status', { phase: 'failed', message: error.message });
    await maybeFinalizeParent(run.parentRunId).catch(() => {});
    throw error;
  }
}

/** When every child of a multitask parent has finished, mark the parent done. */
async function maybeFinalizeParent(parentRunId: string | null) {
  if (!parentRunId) return;
  const children = await prisma.agentRun.findMany({
    where: { parentRunId },
    select: { status: true },
  });
  if (!children.length) return;
  const pending = children.some((c) => c.status === 'queued' || c.status === 'running');
  if (pending) return;
  const anyFailed = children.some((c) => c.status === 'failed');
  await prisma.agentRun.update({
    where: { id: parentRunId },
    data: { status: anyFailed ? 'failed' : 'completed' },
  });
  socketService.emitRunEvent(parentRunId, 'status', { phase: 'done', children: children.length });
}

function deriveTitle(prompt: string): string {
  const t = (prompt || '').trim().replace(/\s+/g, ' ');
  return t.length > 60 ? t.slice(0, 57) + '…' : t || 'New chat';
}

/**
 * AI-generated chat-tab title: a short (2–5 word) summary of the first request.
 * Cheap one-shot call; falls back to a truncation of the prompt on any failure
 * (no key, offline, etc.).
 */
async function generateTitle(prompt: string, model: string, apiKey?: string): Promise<string> {
  try {
    const res = await completeChat({
      model,
      apiKey,
      max_tokens: 24,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content:
            'Generate a concise 2–5 word title in Title Case that summarizes the user\'s software request. No surrounding quotes, no trailing punctuation. Output ONLY the title.',
        },
        { role: 'user', content: prompt.slice(0, 1000) },
      ],
    });
    const raw = (res.content || '').trim().split('\n')[0].replace(/^["'`]+|["'`.]+$/g, '').trim();
    if (!raw) return deriveTitle(prompt);
    return raw.length > 48 ? raw.slice(0, 46) + '…' : raw;
  } catch {
    return deriveTitle(prompt);
  }
}

const worker = createWorker(AGENT_QUEUE_NAME, processAgentJob, { concurrency: AGENT_WORKER_CONCURRENCY });

worker.on('completed', (job) => console.log(`[AgentWorker] Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`[AgentWorker] Job ${job?.id} failed:`, err.message));
worker.on('error', (err) => captureError(err, { worker: 'agent', scope: 'worker' }));

console.log(`[AgentWorker] Started with concurrency: ${AGENT_WORKER_CONCURRENCY}`);

process.on('SIGTERM', async () => {
  console.log('[AgentWorker] SIGTERM received, closing worker...');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});
process.on('SIGINT', async () => {
  console.log('[AgentWorker] SIGINT received, closing worker...');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});

export default worker;
