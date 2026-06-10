import 'dotenv/config';
import crypto from 'crypto';
import type { Job } from 'bullmq';
import { createWorker, COMPILE_QUEUE_NAME } from '../queues/bullmq';
import compilationService, { type LogEntry } from '../services/compilationService';
import socketService from '../services/socketService';
import { parseSpecFromWasmBase64 } from '../services/contractSpec';
import { parseDiagnostics } from '../services/diagnostics';
import prisma from '../lib/prisma';

// Initialize socket service for Redis pub/sub (workers don't have Socket.IO instance)
socketService.init(null);

// Worker concurrency
const COMPILE_WORKER_CONCURRENCY = parseInt(process.env.COMPILE_WORKER_CONCURRENCY || '2', 10);

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
 * Process compile job
 */
async function processCompileJob(job: Job) {
  const { projectId, files, jobId, userId, manifestPath, deployTarget } = job.data;

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
    // Incremental log writes overwrite the whole `result` blob with an
    // in-progress shape and are fire-and-forget, so a late one can land after the
    // final result and flip `success` back to false. Track them, stop accepting
    // new ones once finalized, and drain them before the final write.
    const pendingLogWrites: Promise<any>[] = [];
    let finalized = false;
    const updateJobLogs = async (logs: LogEntry[]) => {
      if (finalized) return Promise.resolve();
      const p = prisma.job
        .update({ where: { id: jobId }, data: { result: { success: false, logs } as any } })
        .catch((err) => console.error('Error updating job logs:', err));
      pendingLogWrites.push(p);
      return p;
    };

    const result: any = await compilationService.compileProject(projectId, files, updateJobLogs, jobId, {
      manifestPath,
      deployTarget
    });

    // No more streaming writes; drain in-flight ones before the final write.
    finalized = true;
    await Promise.allSettled(pendingLogWrites);

    // Structured diagnostics (level/file/line/message) for inline editor markers.
    const diagnostics = parseDiagnostics(result.logs || []);

    const jobResult = {
      success: result.success,
      logs: result.logs,
      diagnostics,
      wasmBase64: result.wasmBase64 || result.output?.wasm,
      wasmFile: result.output?.wasmFile,
      compilationType: result.compilationType,
      error: result.error
    };

    await prisma.job.update({
      where: { id: jobId },
      data: {
        status: result.success ? 'completed' : 'failed',
        result: jobResult as any,
        error: result.success ? null : (result.error || 'Compilation failed')
      }
    });

    // Emit final status via WebSocket
    socketService.emitJobStatus(jobId, result.success ? 'completed' : 'failed', jobResult);

    // Touch project updatedAt + extract & persist the contract spec (feeds invoke).
    if (result.success) {
      const wasmBase64: string | undefined = result.wasmBase64 || result.output?.wasm;
      const projectData: any = { updatedAt: new Date() };
      if (wasmBase64) {
        projectData.wasmHash = crypto.createHash('sha256').update(Buffer.from(wasmBase64, 'base64')).digest('hex');
        try {
          const parsed = parseSpecFromWasmBase64(wasmBase64);
          if (parsed.entries.length > 0) {
            projectData.spec = parsed as any;
            console.log(`[CompileWorker] Extracted spec for project ${projectId}: ${parsed.functions.length} fns`);
          }
        } catch (specError: any) {
          // Non-fatal (e.g. fallback/mock wasm) — compile still succeeds.
          console.warn(`[CompileWorker] Spec extraction skipped for ${projectId}:`, specError.message);
        }
      }
      try {
        await prisma.project.update({ where: { id: projectId }, data: projectData });
        console.log(`[CompileWorker] Updated project ${projectId} with compilation result`);
      } catch (updateError: any) {
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
      } catch (logError: any) {
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
  } catch (error: any) {
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

export default worker;
