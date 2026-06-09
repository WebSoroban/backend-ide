import express, { type Request, type Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { addTestJob } from '../queues/testQueue';
import { authenticate } from '../middleware/auth';

const router = express.Router();

// POST /api/test - Run `cargo test` for a project (queued).
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const { projectId, files } = req.body;
    const user = req.user!;

    if (!projectId || !files) {
      return res.status(400).json({ success: false, error: 'Missing required parameters: projectId and files' });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, userId: true, manifestPath: true, deployTarget: true }
    });
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }
    if (project.userId !== user.id) {
      return res.status(403).json({ success: false, error: 'You do not have permission to test this project' });
    }

    const jobId = crypto.randomUUID();
    const bullJobId = `test-${jobId}`;

    const bullJob = await addTestJob({
      projectId,
      files,
      jobId,
      userId: user.id,
      manifestPath: project.manifestPath,
      deployTarget: project.deployTarget
    });

    if (!bullJob || !bullJob.id) {
      throw new Error('Failed to create BullMQ job');
    }

    const job = await prisma.job.create({
      data: {
        id: jobId,
        type: 'test',
        status: 'queued',
        userId: user.id,
        projectId,
        bullJobId: bullJob.id || bullJobId
      }
    });

    res.status(202).json({
      success: true,
      jobId: job.id,
      message: 'Test job queued',
      logs: [{ type: 'info', message: 'Test job queued successfully', timestamp: new Date().toISOString() }]
    });
  } catch (error: any) {
    console.error('Test queue error:', error);
    res.status(500).json({ success: false, error: 'Failed to queue test job', message: error.message });
  }
});

export default router;
