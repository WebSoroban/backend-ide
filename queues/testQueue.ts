import type { Job } from 'bullmq';
import { createQueue, TEST_QUEUE_NAME } from './bullmq';

// Create test queue instance
const testQueue = createQueue(TEST_QUEUE_NAME);

export interface TestJobPayload {
  projectId: string;
  files: any[];
  jobId: string;
  userId?: string;
  manifestPath?: string;
  deployTarget?: string | null;
}

/**
 * Add a `cargo test` job to the queue.
 */
async function addTestJob(payload: TestJobPayload): Promise<Job> {
  const { projectId, files, jobId, userId, manifestPath, deployTarget } = payload;

  if (!projectId || !files || !jobId) {
    throw new Error('Missing required parameters: projectId, files, and jobId');
  }

  const job = await testQueue.add(
    'test',
    { projectId, files, jobId, userId, manifestPath, deployTarget },
    { jobId: `test-${jobId}`, priority: 1 }
  );

  console.log(`[TestQueue] Added test job ${job.id} for project ${projectId}`);
  return job;
}

export { testQueue, addTestJob };

export default { testQueue, addTestJob };
