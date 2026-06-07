const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { addCompileJob } = require('../queues/compileQueue');
const { authenticate } = require('../middleware/auth');

// POST /api/compile - Compile a project (queued)
router.post('/', authenticate, async (req, res) => {
  try {
    const { projectId, files } = req.body;
    const user = req.user;

    if (!projectId || !files) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: projectId and files'
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
        error: 'You do not have permission to compile this project'
      });
    }

    // Generate the job id up front so we can build the BullMQ job id.
    const jobId = crypto.randomUUID();
    const bullJobId = `compile-${jobId}`;

    // Enqueue compile job
    const bullJob = await addCompileJob({
      projectId,
      files,
      jobId,
      userId: user.id
    });

    // Verify BullMQ job was created
    if (!bullJob || !bullJob.id) {
      throw new Error('Failed to create BullMQ job');
    }

    // Create job record
    const job = await prisma.job.create({
      data: {
        id: jobId,
        type: 'compile',
        status: 'queued',
        userId: user.id,
        projectId,
        bullJobId: bullJob.id || bullJobId
      }
    });

    // Log compilation attempt (unlimited but we log it)
    await prisma.usageLog.create({
      data: {
        userId: user.id,
        action: 'compile',
        projectId,
        success: false,
        metadata: { jobId }
      }
    });

    // Return 202 Accepted with job ID and initial logs
    res.status(202).json({
      success: true,
      jobId: job.id,
      message: 'Compilation job queued',
      logs: [{
        type: 'info',
        message: 'Compilation job queued successfully',
        timestamp: new Date().toISOString()
      }]
    });
  } catch (error) {
    console.error('Compilation queue error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to queue compilation job',
      message: error.message
    });
  }
});

module.exports = router;
