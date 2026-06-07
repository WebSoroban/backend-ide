import express, { type Request, type Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import userService from '../services/userService';
import { addDeployJob } from '../queues/deployQueue';
import deploymentService from '../services/deploymentService';
import walletService from '../services/wallet';
import { authenticate } from '../middleware/auth';

const router = express.Router();

// Testnet only — mainnet is never allowed for server-side deploys.
const NETWORK = 'testnet';

// POST /api/deploy - Deploy a smart contract (queued, signed with the user's wallet)
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, wasmBase64 } = req.body;
    const user = req.user!;

    if (!projectId || !wasmBase64) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: projectId and wasmBase64'
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
      select: { id: true, userId: true }
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

    // Generate the job id up front so we can build the BullMQ job id.
    const jobId = crypto.randomUUID();
    const bullJobId = `deploy-${jobId}`;

    // Enqueue deploy job (the worker signs with the user's wallet).
    const bullJob = await addDeployJob({
      projectId,
      wasmBase64,
      network: NETWORK,
      jobId,
      userId: user.id
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

// POST /api/deploy/prepare-deployment - Synchronous deploy (signed with the user's wallet)
router.post('/prepare-deployment', authenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, wasmBase64 } = req.body;
    const user = req.user!;

    if (!projectId || !wasmBase64) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: projectId and wasmBase64'
      });
    }

    // Deploy contract directly, signing with this user's wallet.
    const deploymentResult = await deploymentService.deployContract(
      projectId,
      wasmBase64,
      NETWORK,
      user.id
    );

    // Record deployment + update project if successful and projectId is a real project.
    if (deploymentResult.success && deploymentResult.contractAddress) {
      try {
        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { id: true }
        });
        if (project) {
          await prisma.project.update({
            where: { id: projectId },
            data: {
              lastDeployed: new Date(),
              contractAddress: deploymentResult.contractAddress,
              deployments: {
                create: {
                  userId: user.id,
                  contractAddress: deploymentResult.contractAddress,
                  deployerPublicKey: deploymentResult.walletAddress,
                  network: NETWORK,
                  status: 'success',
                  logs: (deploymentResult.logs || []).map((l) => l.message)
                }
              }
            }
          });
        }
      } catch (updateError: any) {
        console.warn('Could not update project:', updateError.message);
      }
    }

    res.json({
      success: deploymentResult.success,
      contractAddress: deploymentResult.contractAddress,
      network: deploymentResult.network,
      projectId: deploymentResult.projectId,
      walletAddress: deploymentResult.walletAddress,
      logs: deploymentResult.logs,
      deployed: deploymentResult.success,
      isMock: deploymentResult.isMock || false
    });
  } catch (error: any) {
    console.error('Deployment preparation error:', error);
    res.status(500).json({
      success: false,
      error: 'Deployment preparation failed',
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
