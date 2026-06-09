import type { Job } from 'bullmq';
import { createQueue, COMPILE_QUEUE_NAME } from './bullmq';

// Create compile queue instance
const compileQueue = createQueue(COMPILE_QUEUE_NAME);

export interface CompileJobPayload {
  projectId: string;
  files: any[];
  jobId: string;
  userId?: string;
  /** Project-relative path of the driving Cargo manifest (default "Cargo.toml"). */
  manifestPath?: string;
  /** For workspaces: crate/package name whose wasm to surface for spec/deploy. */
  deployTarget?: string | null;
}

/**
 * Add a compile job to the queue
 */
async function addCompileJob(payload: CompileJobPayload): Promise<Job> {
  const { projectId, files, jobId, userId, manifestPath, deployTarget } = payload;

  if (!projectId || !files || !jobId) {
    throw new Error('Missing required parameters: projectId, files, and jobId');
  }

  const job = await compileQueue.add(
    'compile',
    {
      projectId,
      files,
      jobId,
      userId,
      manifestPath,
      deployTarget
    },
    {
      jobId: `compile-${jobId}`, // Use MongoDB job ID as BullMQ job ID
      priority: 1
    }
  );

  console.log(`[CompileQueue] Added compile job ${job.id} for project ${projectId}`);

  return job;
}

export { compileQueue, addCompileJob };

export default { compileQueue, addCompileJob };
