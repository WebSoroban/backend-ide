import express, { type Request, type Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import userService from '../services/userService';
import { addDeployJob } from '../queues/deployQueue';
import deploymentService from '../services/deploymentService';
import walletService from '../services/wallet';
import stellarService from '../services/stellarService';
import { authenticate } from '../middleware/auth';
import { validateProject } from '../services/projectLayout';
import { parseSpecFromWasmBase64 } from '../services/contractSpec';
import { coerceNetwork, getNetwork, explorerContract, type NetworkId } from '../lib/networks';
import { rateLimit } from '../middleware/rateLimit';

const router = express.Router();

// Shared deploy budget per user (prefix matches routes/ai.ts so AI-initiated
// deploys draw from the same bucket). Fail-open if Redis is unavailable.
const deployLimiter = rateLimit({ windowSec: 60, max: 20, prefix: 'deploy' });

// The queue-based custodial deploy is testnet only. Mainnet deploys are route-
// driven (non-custodial sign-XDR by default, or an explicit custodial opt-in).
const NETWORK = 'testnet';

/** Record a successful deploy on the Project + a Deployment row (any network). */
async function recordDeployment(opts: {
  projectId: string;
  userId: string;
  network: NetworkId;
  contractAddress: string;
  deployerPublicKey: string;
  wasmBase64: string;
  deployTarget?: string | null;
  logs?: string[];
}) {
  let spec: any = undefined;
  let wasmHash: string | undefined;
  try {
    wasmHash = crypto.createHash('sha256').update(Buffer.from(opts.wasmBase64, 'base64')).digest('hex');
    const parsed = parseSpecFromWasmBase64(opts.wasmBase64);
    if (parsed.entries.length > 0) spec = parsed;
  } catch (e: any) {
    console.warn('[Deploy] spec/hash extraction skipped:', e.message);
  }
  await prisma.project.update({
    where: { id: opts.projectId },
    data: {
      lastDeployed: new Date(),
      contractAddress: opts.contractAddress,
      network: opts.network,
      ...(spec ? { spec } : {}),
      ...(wasmHash ? { wasmHash } : {}),
      deployments: {
        create: {
          userId: opts.userId,
          contractAddress: opts.contractAddress,
          deployerPublicKey: opts.deployerPublicKey,
          network: opts.network,
          status: 'success',
          wasmHash: wasmHash ?? null,
          deployTarget: opts.deployTarget ?? null,
          spec: spec ?? undefined,
          logs: opts.logs ?? [],
        },
      },
    },
  });
  await userService.incrementDeployment(opts.userId).catch(() => {});
  // Record an activity log so mainnet (custodial + non-custodial) deploys show up
  // in /analytics and count in the per-network deploy split. The testnet queue
  // path logs this in routes/deploy POST `/` + the worker; this covers the rest.
  await prisma.usageLog
    .create({
      data: {
        userId: opts.userId,
        action: 'deploy',
        projectId: opts.projectId,
        contractAddress: opts.contractAddress,
        success: true,
        metadata: { network: opts.network, walletAddress: opts.deployerPublicKey },
      },
    })
    .catch((e) => console.warn('[Deploy] usageLog (deploy) failed:', e.message));
}

// POST /api/deploy - Deploy a smart contract (queued, signed with the user's wallet)
router.post('/', authenticate, deployLimiter, async (req: Request, res: Response) => {
  try {
    const { projectId, wasmBase64 } = req.body;
    const user = req.user!;

    if (!projectId || !wasmBase64) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: projectId and wasmBase64'
      });
    }

    // The queue path is testnet custodial only. Mainnet must use the explicit,
    // confirmation-gated flow (/deploy/prepare + /deploy/submit for non-custodial,
    // or /deploy/custodial for the custodial opt-in).
    if (coerceNetwork(req.body.network) === 'mainnet') {
      return res.status(400).json({
        success: false,
        error: 'Mainnet deploys require the confirmation flow.',
        code: 'USE_MAINNET_FLOW',
      });
    }

    // Check deployment limit
    const canDeploy = await userService.canDeploy(user);
    if (!canDeploy.allowed) {
      return res.status(403).json({
        success: false,
        error: canDeploy.reason,
        current: canDeploy.current,
        limit: canDeploy.limit,
        upgradeRequired: true
      });
    }

    // Verify project belongs to user
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { files: { select: { path: true, name: true, content: true } } }
    });
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    if (project.userId !== user.id) {
      return res.status(403).json({
        success: false,
        error: 'You do not have permission to deploy this project'
      });
    }

    // Workspace projects with more than one deployable contract require an
    // explicit deploy target. The compiled wasm corresponds to whichever target
    // was selected at compile time; without one we don't know what to deploy.
    const layout = validateProject(project.files, project.manifestPath);
    if (layout.isWorkspace && layout.deployableCrates.length > 1 && !project.deployTarget) {
      return res.status(400).json({
        success: false,
        error: 'This workspace has multiple deployable contracts. Choose a deploy target first.',
        code: 'DEPLOY_TARGET_REQUIRED',
        choices: layout.deployableCrates.map((c) => ({ name: c.name, dir: c.dir }))
      });
    }

    // Generate the job id up front so we can build the BullMQ job id.
    const jobId = crypto.randomUUID();
    const bullJobId = `deploy-${jobId}`;

    // Enqueue deploy job (the worker signs with the user's wallet).
    const bullJob = await addDeployJob({
      projectId,
      wasmBase64,
      network: NETWORK,
      jobId,
      userId: user.id,
      deployTarget: project.deployTarget
    });

    if (!bullJob || !bullJob.id) {
      throw new Error('Failed to create BullMQ job');
    }

    const job = await prisma.job.create({
      data: {
        id: jobId,
        type: 'deploy',
        status: 'queued',
        userId: user.id,
        projectId,
        bullJobId: bullJob.id || bullJobId
      }
    });

    // Log usage attempt (marked successful by the worker on completion).
    await prisma.usageLog.create({
      data: {
        userId: user.id,
        action: 'deploy',
        projectId,
        success: false,
        metadata: { network: NETWORK, jobId }
      }
    });

    res.status(202).json({
      success: true,
      jobId: job.id,
      message: 'Deployment job queued',
      logs: [{
        type: 'info',
        message: 'Deployment job queued successfully',
        timestamp: new Date().toISOString()
      }]
    });
  } catch (error: any) {
    console.error('Deployment queue error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to queue deployment job',
      message: error.message
    });
  }
});

// POST /api/deploy/invoke - Invoke a contract function (read-only simulation)
router.post('/invoke', authenticate, async (req: Request, res: Response) => {
  try {
    const { contractId, functionName, args = [] } = req.body;

    if (!contractId || !functionName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: contractId and functionName'
      });
    }

    const invokeResult = await deploymentService.invokeContract(contractId, functionName, args, null, NETWORK);

    res.json({
      success: invokeResult.success,
      output: invokeResult.output,
      contractId: invokeResult.contractId,
      functionName: invokeResult.functionName,
      args: invokeResult.args,
      logs: invokeResult.logs
    });
  } catch (error: any) {
    console.error('Contract invocation error:', error);
    res.status(500).json({
      success: false,
      error: 'Contract invocation failed',
      message: error.message
    });
  }
});

// GET /api/deploy/network-info - Get network information
router.get('/network-info', async (req: Request, res: Response) => {
  try {
    const networkInfo = await deploymentService.getNetworkInfo(NETWORK);

    res.json({
      success: networkInfo.success,
      network: NETWORK,
      info: networkInfo.info,
      error: networkInfo.error
    });
  } catch (error: any) {
    console.error('Network info error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get network info',
      message: error.message
    });
  }
});

// ---------------------------------------------------------------------------
// NON-CUSTODIAL deploy (mainnet default): the browser wallet signs the XDR.
// Two signed steps: upload the wasm, then create the contract instance.
// ---------------------------------------------------------------------------

// POST /api/deploy/prepare — build + simulate, return the unsigned XDR + fee.
router.post('/prepare', authenticate, deployLimiter, async (req: Request, res: Response) => {
  try {
    const { projectId, wasmBase64, sourcePk, step = 'upload', wasmHashHex } = req.body;
    const network = coerceNetwork(req.body.network);
    if (!wasmBase64 || !sourcePk) {
      return res.status(400).json({ success: false, error: 'wasmBase64 and sourcePk are required' });
    }
    if (projectId) {
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } });
      if (project && project.userId !== req.user!.id) return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    if (step === 'upload') {
      const r = await stellarService.prepareUpload(network, sourcePk, wasmBase64);
      return res.json({ success: true, step: 'upload', network, passphrase: getNetwork(network).passphrase, ...r });
    }
    if (step === 'create') {
      if (!wasmHashHex) return res.status(400).json({ success: false, error: 'wasmHashHex is required for the create step' });
      const r = await stellarService.prepareCreate(network, sourcePk, wasmHashHex, wasmBase64);
      return res.json({ success: true, step: 'create', network, passphrase: getNetwork(network).passphrase, ...r });
    }
    return res.status(400).json({ success: false, error: 'step must be "upload" or "create"' });
  } catch (error: any) {
    console.error('[Deploy] prepare error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

// POST /api/deploy/submit — submit a wallet-signed XDR; on create, record it.
router.post('/submit', authenticate, deployLimiter, async (req: Request, res: Response) => {
  try {
    const { projectId, signedXdr, step = 'upload', sourcePk, wasmBase64, deployTarget } = req.body;
    const network = coerceNetwork(req.body.network);
    if (!signedXdr) return res.status(400).json({ success: false, error: 'signedXdr is required' });

    if (step === 'upload') {
      const r = await stellarService.submitUpload(network, signedXdr);
      return res.json({ success: true, step: 'upload', network, ...r });
    }
    if (step === 'create') {
      if (!projectId || !wasmBase64 || !sourcePk) {
        return res.status(400).json({ success: false, error: 'projectId, wasmBase64 and sourcePk are required for the create step' });
      }
      const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } });
      if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
      if (project.userId !== req.user!.id) return res.status(403).json({ success: false, error: 'Forbidden' });
      const canDeploy = await userService.canDeploy(req.user!);
      if (!canDeploy.allowed) return res.status(403).json({ success: false, error: canDeploy.reason, upgradeRequired: true });

      const r = await stellarService.submitCreate(network, signedXdr);
      await recordDeployment({
        projectId, userId: req.user!.id, network, contractAddress: r.contractId,
        deployerPublicKey: sourcePk, wasmBase64, deployTarget,
      });
      return res.json({
        success: true, step: 'create', network, contractAddress: r.contractId, txHash: r.txHash,
        explorer: explorerContract(network, r.contractId),
      });
    }
    return res.status(400).json({ success: false, error: 'step must be "upload" or "create"' });
  } catch (error: any) {
    console.error('[Deploy] submit error:', error.message);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// CUSTODIAL deploy on mainnet — explicit opt-in, confirmation-gated, real XLM.
// (Testnet custodial keeps using the queue path above.)
// ---------------------------------------------------------------------------
router.post('/custodial', authenticate, deployLimiter, async (req: Request, res: Response) => {
  try {
    const { projectId, wasmBase64, confirm } = req.body;
    const network = coerceNetwork(req.body.network);
    const user = req.user!;
    if (!projectId || !wasmBase64) return res.status(400).json({ success: false, error: 'projectId and wasmBase64 are required' });

    if (network === 'mainnet') {
      if (confirm !== true) {
        return res.status(400).json({ success: false, error: 'Deploying to MAINNET costs real XLM — confirm:true is required.', code: 'CONFIRM_REQUIRED' });
      }
      const mode = await walletService.getMainnetSigningMode(user.id);
      if (mode !== 'custodial') {
        return res.status(400).json({
          success: false,
          error: 'Custodial mainnet signing is not enabled. Connect an external wallet (recommended) or opt into custodial signing first.',
          code: 'CUSTODIAL_DISABLED',
        });
      }
    }

    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true, deployTarget: true } });
    if (!project) return res.status(404).json({ success: false, error: 'Project not found' });
    if (project.userId !== user.id) return res.status(403).json({ success: false, error: 'Forbidden' });
    const canDeploy = await userService.canDeploy(user);
    if (!canDeploy.allowed) return res.status(403).json({ success: false, error: canDeploy.reason, upgradeRequired: true });

    // Make sure the custodial wallet exists (the worker signs with it via the
    // user's decrypted key). Enqueue the deploy so the long two-transaction flow
    // runs in the worker (which has the Stellar CLI) instead of blocking the API
    // request — same queue + polling model as a testnet deploy.
    await walletService.getOrCreateWallet(user.id);

    const jobId = crypto.randomUUID();
    const bullJob = await addDeployJob({
      projectId, wasmBase64, network, jobId, userId: user.id, deployTarget: project.deployTarget,
    });
    if (!bullJob || !bullJob.id) throw new Error('Failed to create BullMQ job');

    const job = await prisma.job.create({
      data: { id: jobId, type: 'deploy', status: 'queued', userId: user.id, projectId, bullJobId: bullJob.id || `deploy-${jobId}` },
    });
    await prisma.usageLog.create({
      data: { userId: user.id, action: 'deploy', projectId, success: false, metadata: { network, jobId } },
    });

    res.status(202).json({
      success: true,
      jobId: job.id,
      network,
      message: 'Deployment job queued',
      logs: [{ type: 'info', message: `Queued ${getNetwork(network).label} deployment…`, timestamp: new Date().toISOString() }],
    });
  } catch (error: any) {
    console.error('[Deploy] custodial error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// GET /api/deploy/wallet-info - Get the logged-in user's deploy wallet (public info only)
router.get('/wallet-info', authenticate, async (req: Request, res: Response) => {
  try {
    const info = await walletService.getPublicWalletInfo(req.userId!);
    res.json({ success: true, wallet: info });
  } catch (error: any) {
    console.error('Wallet info error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get wallet info',
      message: error.message
    });
  }
});

export default router;
