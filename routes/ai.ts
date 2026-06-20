/**
 * AI Copilot API.
 *
 * Streaming itself rides the existing Socket.IO channel (room `run:<runId>`,
 * event `ai:event`) — these HTTP routes start runs, expose state, and handle the
 * gated/explicit actions (apply diffs, undo, deploy). Keys never cross this
 * boundary: BYO OpenRouter keys are encrypted at rest and only ever decrypted
 * inside the worker.
 */
import express, { type Request, type Response } from 'express';
import prisma from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { serializeProject } from '../lib/serialize';
import { encrypt } from '../lib/crypto';
import { sanitizeRelPath, baseName } from '../lib/paths';
import { getRegistry } from '../services/ai/models';
import { addAgentJob } from '../queues/agentQueue';
import { applyHunks } from '../services/ai/diff';
import compilationService from '../services/compilationService';
import deploymentService from '../services/deploymentService';
import userService from '../services/userService';
import { COPILOT_MODES, type CopilotMode, type ProposedEdit } from '../services/ai/types';
import { coerceNetwork } from '../lib/networks';
import { rateLimit } from '../middleware/rateLimit';

const router = express.Router();

const NETWORK = 'testnet';

// Per-user limits on the endpoints that start LLM work or spend on-chain. Reads
// (thread/run/plan GETs) are unmetered. Fail-open if Redis is down.
const aiLimiter = rateLimit({ windowSec: 60, max: 30, prefix: 'ai' });
const aiHeavyLimiter = rateLimit({ windowSec: 60, max: 10, prefix: 'ai-heavy' });
const deployLimiter = rateLimit({ windowSec: 60, max: 20, prefix: 'deploy' });

function isMode(m: any): m is CopilotMode {
  return typeof m === 'string' && (COPILOT_MODES as string[]).includes(m);
}

// ---------------------------------------------------------------------------
// Models + settings
// ---------------------------------------------------------------------------

// GET /api/ai/models — curated registry (+ live catalog for "Add Models").
router.get('/models', authenticate, async (req: Request, res: Response) => {
  try {
    const registry = await getRegistry(req.query.refresh === '1');
    res.json(registry);
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load models', message: error.message });
  }
});

// GET /api/ai/settings — the user's persisted model + mode (no secret returned).
router.get('/settings', authenticate, async (req: Request, res: Response) => {
  try {
    const s = await prisma.aiSetting.findUnique({ where: { userId: req.user!.id } });
    res.json({
      selectedModel: s?.selectedModel || 'openrouter/auto',
      mode: s?.mode || 'agent',
      maxMode: s?.maxMode || false,
      hasOwnKey: !!s?.openRouterKeyEncrypted,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load settings', message: error.message });
  }
});

// PUT /api/ai/settings — persist model/mode/maxMode and (optionally) a BYO key.
router.put('/settings', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { selectedModel, mode, maxMode, openRouterKey } = req.body;
    const data: any = {};
    if (typeof selectedModel === 'string') data.selectedModel = selectedModel;
    if (isMode(mode)) data.mode = mode;
    if (typeof maxMode === 'boolean') data.maxMode = maxMode;
    if (typeof openRouterKey === 'string') {
      // Empty string clears the key; otherwise encrypt at rest like wallet secrets.
      data.openRouterKeyEncrypted = openRouterKey.trim() ? encrypt(openRouterKey.trim()) : null;
    }
    const s = await prisma.aiSetting.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });
    res.json({
      selectedModel: s.selectedModel,
      mode: s.mode,
      maxMode: s.maxMode,
      hasOwnKey: !!s.openRouterKeyEncrypted,
    });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to save settings', message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

// GET /api/ai/threads?projectId= — list the user's threads.
router.get('/threads', authenticate, async (req: Request, res: Response) => {
  try {
    const where: any = { userId: req.user!.id };
    if (req.query.projectId) where.projectId = req.query.projectId as string;
    const threads = await prisma.chatThread.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 100 });
    res.json(threads.map((t) => ({ ...t, _id: t.id })));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to list threads', message: error.message });
  }
});

// POST /api/ai/threads — start a new conversation (one mode = one context window).
router.post('/threads', authenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, mode, model, maxMode, title } = req.body;
    const thread = await prisma.chatThread.create({
      data: {
        userId: req.user!.id,
        projectId: projectId || null,
        mode: isMode(mode) ? mode : 'agent',
        model: typeof model === 'string' && model ? model : 'openrouter/auto',
        maxMode: maxMode === true,
        title: typeof title === 'string' && title.trim() ? title.trim() : 'New chat',
      },
    });
    res.status(201).json({ ...thread, _id: thread.id });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to create thread', message: error.message });
  }
});

// GET /api/ai/threads/:id — thread with its messages + tool calls.
router.get('/threads/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const thread = await prisma.chatThread.findUnique({
      where: { id: req.params.id },
      include: {
        messages: { orderBy: { createdAt: 'asc' }, include: { toolCalls: true } },
      },
    });
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    if (thread.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    res.json({ ...thread, _id: thread.id });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load thread', message: error.message });
  }
});

// PATCH /api/ai/threads/:id — update model / maxMode / title / mode.
router.patch('/threads/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const thread = await prisma.chatThread.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    if (thread.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    const { model, maxMode, title, mode } = req.body;
    const data: any = {};
    if (typeof model === 'string') data.model = model;
    if (typeof maxMode === 'boolean') data.maxMode = maxMode;
    if (typeof title === 'string') data.title = title;
    if (isMode(mode)) data.mode = mode;
    const updated = await prisma.chatThread.update({ where: { id: req.params.id }, data });
    res.json({ ...updated, _id: updated.id });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update thread', message: error.message });
  }
});

// DELETE /api/ai/threads/:id
router.delete('/threads/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const thread = await prisma.chatThread.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    if (thread.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    await prisma.chatThread.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete thread', message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Messages → start a run
// ---------------------------------------------------------------------------

// POST /api/ai/threads/:id/messages — send a user turn and start an agent run.
router.post('/threads/:id/messages', authenticate, aiLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const thread = await prisma.chatThread.findUnique({ where: { id: req.params.id } });
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    if (thread.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

    const { content, context, attachments, model, maxMode, mode } = req.body;
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content is required' });
    }
    if (!thread.projectId) return res.status(400).json({ error: 'Thread is not attached to a project' });

    const runMode: CopilotMode = isMode(mode) ? mode : (thread.mode as CopilotMode);
    const runModel = typeof model === 'string' && model ? model : thread.model;
    const runMax = typeof maxMode === 'boolean' ? maxMode : thread.maxMode;

    // Persist the user's mode/model choice for next time.
    await prisma.aiSetting.upsert({
      where: { userId },
      update: { selectedModel: runModel, mode: runMode, maxMode: runMax },
      create: { userId, selectedModel: runModel, mode: runMode, maxMode: runMax },
    });
    // Keep the thread's pinned model/mode in sync.
    await prisma.chatThread.update({
      where: { id: thread.id },
      data: { model: runModel, maxMode: runMax, mode: runMode },
    });

    const userMessage = await prisma.chatMessage.create({
      data: {
        threadId: thread.id,
        userId,
        role: 'user',
        content,
        meta: { context: typeof context === 'string' ? context : '', attachments: attachments || [] } as any,
      },
    });

    const run = await prisma.agentRun.create({
      data: {
        userId,
        threadId: thread.id,
        projectId: thread.projectId,
        mode: runMode,
        model: runModel,
        maxMode: runMax,
        status: 'queued',
        prompt: content,
        title: content.slice(0, 60),
      },
    });
    await prisma.agentRun.update({ where: { id: run.id }, data: { bullJobId: `agent-${run.id}` } });
    await addAgentJob({ runId: run.id });

    res.status(202).json({ runId: run.id, userMessageId: userMessage.id, mode: runMode, model: runModel });
  } catch (error: any) {
    console.error('[ai] start run error:', error);
    res.status(500).json({ error: 'Failed to start run', message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

// GET /api/ai/runs?threadId=&parentRunId= — list runs (e.g. multitask dashboard).
router.get('/runs', authenticate, async (req: Request, res: Response) => {
  try {
    const where: any = { userId: req.user!.id };
    if (req.query.threadId) where.threadId = req.query.threadId as string;
    if (req.query.parentRunId) where.parentRunId = req.query.parentRunId as string;
    const runs = await prisma.agentRun.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
    res.json(runs.map((r) => ({ ...r, _id: r.id })));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to list runs', message: error.message });
  }
});

// GET /api/ai/runs/:id — run status + diffs + tool calls.
router.get('/runs/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const run = await prisma.agentRun.findUnique({ where: { id: req.params.id }, include: { toolCalls: true } });
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    res.json({ ...run, _id: run.id });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load run', message: error.message });
  }
});

// POST /api/ai/runs/:id/cancel — cooperative cancel (takes effect at the next
// tool-loop boundary in the worker).
router.post('/runs/:id/cancel', authenticate, async (req: Request, res: Response) => {
  try {
    const run = await prisma.agentRun.findUnique({ where: { id: req.params.id }, select: { userId: true, status: true } });
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    if (run.status === 'completed' || run.status === 'failed') {
      return res.json({ success: true, status: run.status });
    }
    await prisma.agentRun.update({ where: { id: req.params.id }, data: { status: 'cancelled' } });
    res.json({ success: true, status: 'cancelled' });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to cancel run', message: error.message });
  }
});

/** Resolve a run + its owned project, or send the appropriate error. */
async function loadRunProject(req: Request, res: Response) {
  const run = await prisma.agentRun.findUnique({ where: { id: req.params.id } });
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return null;
  }
  if (run.userId !== req.user!.id) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  if (!run.projectId) {
    res.status(400).json({ error: 'Run has no project' });
    return null;
  }
  const project = await prisma.project.findUnique({
    where: { id: run.projectId },
    include: { files: { select: { path: true, content: true } } },
  });
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  return { run, project };
}

/** Replace a project's file set atomically (mirrors routes/projects PUT). */
async function replaceProjectFiles(projectId: string, files: { path: string; content: string }[]) {
  const rows = files.map((f) => {
    const rel = sanitizeRelPath(f.path);
    return { projectId, path: rel, name: baseName(rel), type: 'file', content: f.content ?? '' };
  });
  await prisma.$transaction(async (tx) => {
    await tx.file.deleteMany({ where: { projectId } });
    if (rows.length) await tx.file.createMany({ data: rows });
    await tx.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
  });
}

// POST /api/ai/runs/:id/apply — apply accepted diffs to the project.
// body.accept = 'all' | { "<path>": "all" | "reject" | number[] }  (per-hunk)
router.post('/runs/:id/apply', authenticate, async (req: Request, res: Response) => {
  try {
    const loaded = await loadRunProject(req, res);
    if (!loaded) return;
    const { run, project } = loaded;
    const edits = (run.diffs as unknown as ProposedEdit[]) || [];
    if (!edits.length) return res.status(400).json({ error: 'This run produced no edits.' });

    const accept = req.body.accept ?? 'all';
    const fileMap = new Map(project.files.map((f) => [f.path, f.content]));

    for (const edit of edits) {
      const sel = accept === 'all' ? 'all' : (req.body.accept || {})[edit.path];
      if (sel === undefined || sel === 'reject') continue; // not accepted → leave as-is

      if (edit.op === 'delete') {
        fileMap.delete(edit.path);
      } else if (edit.op === 'create') {
        const content =
          sel === 'all' || accept === 'all' ? edit.content ?? '' : applyHunks('', edit.content ?? '', sel as number[]);
        fileMap.set(edit.path, content);
      } else {
        // modify
        const prev = edit.previousContent ?? fileMap.get(edit.path) ?? '';
        const content =
          sel === 'all' || accept === 'all'
            ? edit.content ?? ''
            : applyHunks(prev, edit.content ?? '', sel as number[]);
        fileMap.set(edit.path, content);
      }
    }

    await replaceProjectFiles(project.id, [...fileMap.entries()].map(([path, content]) => ({ path, content })));
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { result: { ...((run.result as any) || {}), applied: true } as any },
    });

    const updated = await prisma.project.findUnique({
      where: { id: project.id },
      include: { files: true, deployments: { orderBy: { createdAt: 'desc' } } },
    });
    res.json({ success: true, project: serializeProject(updated) });
  } catch (error: any) {
    console.error('[ai] apply error:', error);
    res.status(500).json({ error: 'Failed to apply edits', message: error.message });
  }
});

// POST /api/ai/runs/:id/undo — restore the project to the run's checkpoint.
router.post('/runs/:id/undo', authenticate, async (req: Request, res: Response) => {
  try {
    const loaded = await loadRunProject(req, res);
    if (!loaded) return;
    const { run, project } = loaded;
    const checkpoint = (run.checkpoint as any)?.files as { path: string; content: string }[] | undefined;
    if (!checkpoint) return res.status(400).json({ error: 'No checkpoint for this run.' });

    await replaceProjectFiles(project.id, checkpoint);
    await prisma.agentRun.update({
      where: { id: run.id },
      data: { result: { ...((run.result as any) || {}), applied: false, undone: true } as any },
    });

    const updated = await prisma.project.findUnique({
      where: { id: project.id },
      include: { files: true, deployments: { orderBy: { createdAt: 'desc' } } },
    });
    res.json({ success: true, project: serializeProject(updated) });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to undo', message: error.message });
  }
});

// POST /api/ai/runs/:id/deploy — GATED deploy: requires explicit confirm. The
// agent never deploys inside its loop; this is the user-confirmed path.
router.post('/runs/:id/deploy', authenticate, deployLimiter, async (req: Request, res: Response) => {
  try {
    if (req.body.confirm !== true) {
      return res.status(400).json({ error: 'Deployment requires explicit confirmation (confirm: true).' });
    }
    // The Copilot never deploys to mainnet — that always requires a human at the
    // Deploy panel confirming the real-XLM transaction.
    if (coerceNetwork(req.body.network) === 'mainnet') {
      return res.status(403).json({
        error: 'The Copilot cannot deploy to mainnet. Use the Deploy panel and confirm the mainnet transaction yourself.',
      });
    }
    const loaded = await loadRunProject(req, res);
    if (!loaded) return;
    const { project } = loaded;
    const user = req.user!;

    const canDeploy = await userService.canDeploy(user);
    if (!canDeploy.allowed) {
      return res.status(403).json({ error: canDeploy.reason, upgradeRequired: true });
    }

    // Compile the CURRENT project, then deploy the produced wasm (testnet only).
    const compileResult: any = await compilationService.compileProject(
      project.id,
      project.files,
      null,
      `ai-deploy-${project.id}-${Date.now()}`,
      { manifestPath: (project as any).manifestPath, deployTarget: (project as any).deployTarget }
    );
    const wasmBase64 = compileResult.wasmBase64 || compileResult.output?.wasm;
    if (!compileResult.success || !wasmBase64) {
      return res.status(400).json({ error: 'Compile failed — fix errors before deploying.', logs: compileResult.logs });
    }

    const deployResult = await deploymentService.deployContract(project.id, wasmBase64, NETWORK, user.id);
    if (deployResult.success && deployResult.contractAddress) {
      await prisma.project.update({
        where: { id: project.id },
        data: {
          lastDeployed: new Date(),
          contractAddress: deployResult.contractAddress,
          deployments: {
            create: {
              userId: user.id,
              contractAddress: deployResult.contractAddress,
              deployerPublicKey: deployResult.walletAddress,
              network: NETWORK,
              status: 'success',
              logs: (deployResult.logs || []).map((l: any) => l.message),
            },
          },
        },
      });
    }
    res.json({
      success: deployResult.success,
      contractAddress: deployResult.contractAddress,
      walletAddress: deployResult.walletAddress,
      logs: deployResult.logs,
    });
  } catch (error: any) {
    console.error('[ai] deploy error:', error);
    res.status(500).json({ error: 'Deploy failed', message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Plans (PLAN mode artifacts)
// ---------------------------------------------------------------------------

router.get('/plans', authenticate, async (req: Request, res: Response) => {
  try {
    const where: any = { userId: req.user!.id };
    if (req.query.projectId) where.projectId = req.query.projectId as string;
    if (req.query.threadId) where.threadId = req.query.threadId as string;
    const plans = await prisma.plan.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 100 });
    res.json(plans.map((p) => ({ ...p, _id: p.id })));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to list plans', message: error.message });
  }
});

router.get('/plans/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (plan.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    res.json({ ...plan, _id: plan.id });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load plan', message: error.message });
  }
});

router.put('/plans/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (plan.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    const { content, title, status } = req.body;
    const data: any = {};
    if (typeof content === 'string') data.content = content;
    if (typeof title === 'string') data.title = title;
    if (typeof status === 'string') data.status = status;
    const updated = await prisma.plan.update({ where: { id: req.params.id }, data });
    res.json({ ...updated, _id: updated.id });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update plan', message: error.message });
  }
});

// POST /api/ai/plans/:id/build — hand the (edited) plan to an Agent run.
router.post('/plans/:id/build', authenticate, aiLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id } });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (plan.userId !== userId) return res.status(403).json({ error: 'Forbidden' });
    if (!plan.projectId) return res.status(400).json({ error: 'Plan has no project' });

    // Build runs in AGENT mode against the plan content, in a fresh thread.
    const model = typeof req.body.model === 'string' && req.body.model ? req.body.model : 'openrouter/auto';
    const maxMode = req.body.maxMode === true;
    const thread = await prisma.chatThread.create({
      data: { userId, projectId: plan.projectId, mode: 'agent', model, maxMode, title: plan.title },
    });
    const prompt = `Implement the following approved plan step by step. After each step, compile and fix errors before moving on.\n\n${plan.content}`;
    await prisma.chatMessage.create({
      data: { threadId: thread.id, userId, role: 'user', content: prompt, meta: { fromPlan: plan.id } as any },
    });
    const run = await prisma.agentRun.create({
      data: {
        userId,
        threadId: thread.id,
        projectId: plan.projectId,
        mode: 'agent',
        model,
        maxMode,
        status: 'queued',
        prompt,
        title: `Build: ${plan.title}`,
      },
    });
    await prisma.agentRun.update({ where: { id: run.id }, data: { bullJobId: `agent-${run.id}` } });
    await prisma.plan.update({ where: { id: plan.id }, data: { status: 'building' } });
    await addAgentJob({ runId: run.id });

    res.status(202).json({ runId: run.id, threadId: thread.id });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to build plan', message: error.message });
  }
});

router.delete('/plans/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const plan = await prisma.plan.findUnique({ where: { id: req.params.id }, select: { userId: true } });
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (plan.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    await prisma.plan.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete plan', message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Multitask — spawn parallel runs
// ---------------------------------------------------------------------------

// POST /api/ai/multitask — { projectId, tasks: [{prompt, mode?, model?, maxMode?}], model?, maxMode? }
router.post('/multitask', authenticate, aiHeavyLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const { projectId, tasks, model, maxMode } = req.body;
    if (!projectId) return res.status(400).json({ error: 'projectId is required' });
    if (!Array.isArray(tasks) || tasks.length === 0) return res.status(400).json({ error: 'tasks[] is required' });
    if (tasks.length > 8) return res.status(400).json({ error: 'Too many parallel tasks (max 8).' });

    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, userId: true } });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.userId !== userId) return res.status(403).json({ error: 'Forbidden' });

    const baseModel = typeof model === 'string' && model ? model : 'openrouter/auto';
    const baseMax = maxMode === true;

    // Parent run groups the children for the dashboard.
    const parent = await prisma.agentRun.create({
      data: {
        userId,
        projectId,
        mode: 'multitask',
        model: baseModel,
        maxMode: baseMax,
        status: 'running',
        prompt: `Multitask: ${tasks.length} parallel sub-tasks`,
        title: 'Multitask run',
      },
    });

    const runIds: string[] = [];
    for (const t of tasks) {
      if (!t || typeof t.prompt !== 'string' || !t.prompt.trim()) continue;
      const child = await prisma.agentRun.create({
        data: {
          userId,
          projectId,
          parentRunId: parent.id,
          mode: isMode(t.mode) ? t.mode : 'multitask',
          model: typeof t.model === 'string' && t.model ? t.model : baseModel,
          maxMode: typeof t.maxMode === 'boolean' ? t.maxMode : baseMax,
          status: 'queued',
          prompt: t.prompt,
          title: t.prompt.slice(0, 60),
        },
      });
      await prisma.agentRun.update({ where: { id: child.id }, data: { bullJobId: `agent-${child.id}` } });
      await addAgentJob({ runId: child.id });
      runIds.push(child.id);
    }

    res.status(202).json({ parentRunId: parent.id, runIds });
  } catch (error: any) {
    console.error('[ai] multitask error:', error);
    res.status(500).json({ error: 'Failed to start multitask', message: error.message });
  }
});

export default router;
