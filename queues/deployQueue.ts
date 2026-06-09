import type { Job } from 'bullmq';
import { createQueue, DEPLOY_QUEUE_NAME } from './bullmq';

// Create deploy queue instance
const deployQueue = createQueue(DEPLOY_QUEUE_NAME);

export interface DeployJobPayload {
  projectId: string;
  wasmBase64: string;
  network?: string;
  jobId: string;
  userId?: string;
  walletInfo?: any;
  /** Workspace member being deployed (recorded on the Deployment row). */
  deployTarget?: string | null;
}

/**
 * Add a deploy job to the queue
 */
async function addDeployJob(payload: DeployJobPayload): Promise<Job> {
  const { projectId, wasmBase64, network = 'testnet', jobId, userId, walletInfo, deployTarget } = payload;

  if (!projectId || !wasmBase64 || !jobId) {
    throw new Error('Missing required parameters: projectId, wasmBase64, and jobId');
  }

  const job = await deployQueue.add(
    'deploy',
    {
      projectId,
      wasmBase64,
      network,
      jobId,
      userId,
      walletInfo,
      deployTarget
    },
    {
      jobId: `deploy-${jobId}`, // Use MongoDB job ID as BullMQ job ID
      priority: 1
    }
  );

  console.log(`[DeployQueue] Added deploy job ${job.id} for project ${projectId}`);

  return job;
}

export { deployQueue, addDeployJob };

export default { deployQueue, addDeployJob };
