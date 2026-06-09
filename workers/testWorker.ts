import 'dotenv/config';
import type { Job } from 'bullmq';
import { createWorker, TEST_QUEUE_NAME } from '../queues/bullmq';
import testService from '../services/testService';
import socketService from '../services/socketService';
import { parseDiagnostics } from '../services/diagnostics';
import type { LogEntry } from '../services/compilationService';
import prisma from '../lib/prisma';

// Initialize socket service for Redis pub/sub (workers don't have Socket.IO instance)
socketService.init(null);

const TEST_WORKER_CONCURRENCY = parseInt(process.env.TEST_WORKER_CONCURRENCY || '2', 10);

/**
 * Process a `cargo test` job — runs the project's unit + integration tests and
 * records per-file results so the IDE can show pass/fail against each source
 * file and a real "Tests N/M" counter.
 */
async function processTestJob(job: Job) {
  const { projectId, files, jobId, userId, manifestPath, deployTarget } = job.data;

  console.log(`[TestWorker] Processing test job ${job.id} for project ${projectId}`);

  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'active',
      result: {
        success: false,
        logs: [{ type: 'info', message: 'Test run started…', timestamp: new Date().toISOString() }]
      }
    }
  });

  try {
    const updateJobLogs = async (logs: LogEntry[]) => {
      try {
        await prisma.job.update({ where: { id: jobId }, data: { result: { success: false, logs } as any } });
      } catch (err) {
        console.error('Error updating test job logs:', err);
      }
    };

    const result = await testService.runTests(projectId, files, updateJobLogs, jobId, {
      manifestPath,
      deployTarget
    });

    // When the test binary fails to compile, surface per-file diagnostics too.
    const diagnostics = result.compileFailed ? parseDiagnostics(result.logs || []) : [];

    const jobResult = {
      success: result.success,
      total: result.total,
      passed: result.passed,
      failed: result.failed,
      ignored: result.ignored,
      tests: result.tests,
      diagnostics,
      compileFailed: result.compileFailed || false,
      logs: result.logs,
      error: result.success ? null : result.error || 'Tests failed'
    };

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: result.success ? 'completed' : 'failed',
        result: jobResult as any,
        error: result.success ? null : result.error || 'Tests failed'
      }
    });

    socketService.emitJobStatus(jobId, result.success ? 'completed' : 'failed', jobResult);

    console.log(`[TestWorker] Completed test job ${job.id} - ${result.passed}/${result.total} passed`);
    return jobResult;
  } catch (error: any) {
    console.error(`[TestWorker] Error processing test job ${job.id}:`, error);
    const errorLogs = [{ type: 'error', message: `Test run failed: ${error.message}`, timestamp: new Date().toISOString() }];
    await prisma.job
      .update({
        where: { id: jobId },
        data: { status: 'failed', result: { success: false, logs: errorLogs, error: error.message }, error: error.message }
      })
      .catch(() => {});
    throw error;
  }
}

const worker = createWorker(TEST_QUEUE_NAME, processTestJob, { concurrency: TEST_WORKER_CONCURRENCY });

worker.on('completed', (job) => console.log(`[TestWorker] Job ${job.id} completed`));
worker.on('failed', (job, err) => console.error(`[TestWorker] Job ${job?.id} failed:`, err.message));
worker.on('error', (err) => console.error('[TestWorker] Worker error:', err));

console.log(`[TestWorker] Started with concurrency: ${TEST_WORKER_CONCURRENCY}`);

process.on('SIGTERM', async () => {
  console.log('[TestWorker] SIGTERM received, closing worker...');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[TestWorker] SIGINT received, closing worker...');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});

export default worker;
