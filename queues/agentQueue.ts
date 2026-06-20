import type { Job } from 'bullmq';
import { createQueue, AGENT_QUEUE_NAME } from './bullmq';

// One queue for every AI Copilot run. A normal chat turn enqueues one job; a
// MULTITASK run enqueues several child jobs (each its own AgentRun row).
const agentQueue = createQueue(AGENT_QUEUE_NAME);

export interface AgentJobPayload {
  /** AgentRun.id — the worker loads everything else from the row. */
  runId: string;
}

async function addAgentJob(payload: AgentJobPayload): Promise<Job> {
  const { runId } = payload;
  if (!runId) throw new Error('Missing required parameter: runId');
  const job = await agentQueue.add(
    'agent',
    { runId },
    { jobId: `agent-${runId}`, priority: 1 }
  );
  console.log(`[AgentQueue] Added agent job ${job.id} for run ${runId}`);
  return job;
}

export { agentQueue, addAgentJob };
export default { agentQueue, addAgentJob };
