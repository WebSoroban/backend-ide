import 'dotenv/config';
import crypto from 'crypto';
import type { Job } from 'bullmq';
import { createWorker, DEPLOY_QUEUE_NAME } from '../queues/bullmq';
import deploymentService from '../services/deploymentService';
import socketService from '../services/socketService';
import userService from '../services/userService';
import { parseSpecFromWasmBase64 } from '../services/contractSpec';
import prisma from '../lib/prisma';
import type { LogEntry } from '../services/compilationService';

// Initialize socket service for Redis pub/sub (workers don't have Socket.IO instance)
socketService.init(null);

// Testnet only.
const NETWORK = 'testnet';

// Worker concurrency
const DEPLOY_WORKER_CONCURRENCY = parseInt(process.env.DEPLOY_WORKER_CONCURRENCY || '2', 10);

/** Update the latest pending usage log for an action (replaces findOneAndUpdate+sort). */
async function updateLatestUsageLog(userId: string, action: string, projectId: string, data: any) {
  const log = await prisma.usageLog.findFirst({
    where: { userId, action, projectId, success: false },
    orderBy: { createdAt: 'desc' }
  });
  if (log) {
    await prisma.usageLog.update({ where: { id: log.id }, data });
  }
}

/**
 * Process deploy job — signs the contract deploy with the requesting user's
 * own Stellar testnet wallet (loaded server-side inside deploymentService).
 */
async function processDeployJob(job: Job) {
  const { projectId, wasmBase64, jobId, userId } = job.data;

  console.log(`[DeployWorker] Processing deploy job ${job.id} for project ${projectId}`);

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'active',
      result: {
        success: false,
        logs: [{ type: 'info', message: 'Deployment started...', timestamp: new Date().toISOString() }]
      }
    }
  });

  try {
    const updateJobLogs = async (logs: LogEntry[]) => {
      try {
        await prisma.job.update({ where: { id: jobId }, data: { result: { success: false, logs } as any } });
      } catch (err) {
        console.error('Error updating deployment job logs:', err);
      }
    };

    // Deploy, signing with the user's wallet (loaded via userId).
    const result = await deploymentService.deployContract(
      projectId,
      wasmBase64,
      NETWORK,
      userId,
      updateJobLogs,
      jobId
    );

    const jobResult: any = {
      success: result.success,
      contractAddress: result.contractAddress,
      network: result.network,
      projectId: result.projectId,
      walletAddress: result.walletAddress,
      logs: result.logs,
      error: result.error
    };

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: result.success ? 'completed' : 'failed',
        result: jobResult,
        error: result.success ? null : (result.error || 'Deployment failed')
      }
    });

    socketService.emitJobStatus(jobId, result.success ? 'completed' : 'failed', jobResult);

    if (result.success && result.contractAddress) {
      // Extract spec + wasm hash so the deployed contract can be invoked even if
      // it was never compiled in this session.
      let spec: any = undefined;
      let wasmHash: string | undefined;
      if (wasmBase64) {
        wasmHash = crypto.createHash('sha256').update(Buffer.from(wasmBase64, 'base64')).digest('hex');
        try {
          const parsed = parseSpecFromWasmBase64(wasmBase64);
          if (parsed.entries.length > 0) spec = parsed;
        } catch (specError: any) {
          console.warn(`[DeployWorker] Spec extraction skipped for ${projectId}:`, specError.message);
        }
      }

      // Record the deployment with the deployer's public key + contract id.
      try {
        await prisma.project.update({
          where: { id: projectId },
          data: {
            lastDeployed: new Date(),
            contractAddress: result.contractAddress,
            ...(spec ? { spec } : {}),
            ...(wasmHash ? { wasmHash } : {}),
            deployments: {
              create: {
                userId,
                contractAddress: result.contractAddress,
                deployerPublicKey: result.walletAddress,
                network: NETWORK,
                status: 'success',
                wasmHash: wasmHash ?? null,
                spec: spec ?? undefined,
                logs: (result.logs || []).map((log) => log.message)
              }
            }
          }
        });
        console.log(`[DeployWorker] Recorded deployment for project ${projectId}`);
      } catch (updateError: any) {
        console.warn(`[DeployWorker] Could not update project ${projectId}:`, updateError.message);
      }

      // Increment user deployment count + mark usage log successful
      if (userId) {
        try {
          await userService.incrementDeployment(userId);
          await updateLatestUsageLog(userId, 'deploy', projectId, {
            success: true,
            contractAddress: result.contractAddress,
            metadata: { network: NETWORK, walletAddress: result.walletAddress }
          });
        } catch (userError: any) {
          console.warn(`[DeployWorker] Could not update user deployment count:`, userError.message);
        }
      }
    } else if (userId) {
      try {
        await updateLatestUsageLog(userId, 'deploy', projectId, {
          success: false,
          error: result.error || 'Deployment failed',
          metadata: { network: NETWORK, error: result.error }
        });
      } catch (logError: any) {
        console.warn(`[DeployWorker] Could not update usage log:`, logError.message);
      }
    }

    console.log(`[DeployWorker] Completed deploy job ${job.id} - success: ${result.success}`);

    return {
      success: result.success,
      contractAddress: result.contractAddress,
      network: result.network,
      projectId: result.projectId,
      walletAddress: result.walletAddress,
      logs: result.logs
    };
  } catch (error: any) {
    console.error(`[DeployWorker] Error processing deploy job ${job.id}:`, error);

    const errorLogs = [{
      type: 'error',
      message: `Deployment failed: ${error.message}`,
      timestamp: new Date().toISOString()
    }];

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: 'failed',
        result: { success: false, logs: errorLogs, error: error.message },
        error: error.message
      }
    }).catch(() => {});

    throw error;
  }
}

const worker = createWorker(DEPLOY_QUEUE_NAME, processDeployJob, {
  concurrency: DEPLOY_WORKER_CONCURRENCY
});

worker.on('completed', (job) => {
  console.log(`[DeployWorker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[DeployWorker] Job ${job?.id} failed:`, err.message);
});

worker.on('error', (err) => {
  console.error('[DeployWorker] Worker error:', err);
});

console.log(`[DeployWorker] Started with concurrency: ${DEPLOY_WORKER_CONCURRENCY}`);

process.on('SIGTERM', async () => {
  console.log('[DeployWorker] SIGTERM received, closing worker...');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[DeployWorker] SIGINT received, closing worker...');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});

export default worker;
