require('dotenv').config();
const { createWorker, COMPILE_QUEUE_NAME } = require('../queues/bullmq');
const compilationService = require('../services/compilationService');
const socketService = require('../services/socketService');
const prisma = require('../lib/prisma');

// Initialize socket service for Redis pub/sub (workers don't have Socket.IO instance)
socketService.init(null);

// Worker concurrency
const COMPILE_WORKER_CONCURRENCY = parseInt(process.env.COMPILE_WORKER_CONCURRENCY || '2', 10);

/** Update the latest pending usage log for an action (replaces findOneAndUpdate+sort). */
async function updateLatestUsageLog(userId, action, projectId, data) {
  const log = await prisma.usageLog.findFirst({
    where: { userId, action, projectId, success: false },
    orderBy: { createdAt: 'desc' }
  });
  if (log) {
    await prisma.usageLog.update({ where: { id: log.id }, data });
  }
}

/**
 * Process compile job
 */
async function processCompileJob(job) {
  const { projectId, files, jobId, userId } = job.data;

  console.log(`[CompileWorker] Processing compile job ${job.id} for project ${projectId}`);

  // Update job status to active
  await prisma.job.update({
    where: { id: jobId },
    data: {
      status: 'active',
      result: {
        success: false,
        logs: [{ type: 'info', message: 'Compilation started...', timestamp: new Date().toISOString() }]
      }
    }
  });

  try {
    // Create callback to update job with logs incrementally
    const updateJobLogs = async (logs) => {
      try {
        await prisma.job.update({
          where: { id: jobId },
          data: { result: { success: false, logs } }
        });
      } catch (err) {
        console.error('Error updating job logs:', err);
      }
    };

    const result = await compilationService.compileProject(projectId, files, updateJobLogs, jobId);

    const jobResult = {
      success: result.success,
      logs: result.logs,
      wasmBase64: result.wasmBase64 || result.output?.wasm,
      wasmFile: result.output?.wasmFile,
      compilationType: result.compilationType,
      error: result.error
    };

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: result.success ? 'completed' : 'failed',
        result: jobResult,
        error: result.success ? null : (result.error || 'Compilation failed')
      }
    });

    // Emit final status via WebSocket
    socketService.emitJobStatus(jobId, result.success ? 'completed' : 'failed', jobResult);

    // Touch project updatedAt if successful
    if (result.success) {
      try {
        await prisma.project.update({ where: { id: projectId }, data: { updatedAt: new Date() } });
        console.log(`[CompileWorker] Updated project ${projectId} with compilation result`);
      } catch (updateError) {
        console.warn(`[CompileWorker] Could not update project ${projectId}:`, updateError.message);
      }
    }

    // Update usage log
    if (userId) {
      try {
        await updateLatestUsageLog(userId, 'compile', projectId, {
          success: result.success,
          error: result.success ? null : (result.error || 'Compilation failed'),
          metadata: { wasmFile: result.output?.wasmFile, compilationType: result.compilationType }
        });
      } catch (logError) {
        console.warn(`[CompileWorker] Could not update usage log:`, logError.message);
      }
    }

    console.log(`[CompileWorker] Completed compile job ${job.id} - success: ${result.success}`);

    return {
      success: result.success,
      logs: result.logs,
      wasmBase64: result.wasmBase64 || result.output?.wasm,
      wasmFile: result.output?.wasmFile,
      compilationType: result.compilationType
    };
  } catch (error) {
    console.error(`[CompileWorker] Error processing compile job ${job.id}:`, error);

    const errorLogs = [{
      type: 'error',
      message: `Compilation failed: ${error.message}`,
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

// Create worker
const worker = createWorker(COMPILE_QUEUE_NAME, processCompileJob, {
  concurrency: COMPILE_WORKER_CONCURRENCY
});

worker.on('completed', (job) => {
  console.log(`[CompileWorker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[CompileWorker] Job ${job?.id} failed:`, err.message);
});

worker.on('error', (err) => {
  console.error('[CompileWorker] Worker error:', err);
});

console.log(`[CompileWorker] Started with concurrency: ${COMPILE_WORKER_CONCURRENCY}`);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[CompileWorker] SIGTERM received, closing worker...');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[CompileWorker] SIGINT received, closing worker...');
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
});

module.exports = worker;
