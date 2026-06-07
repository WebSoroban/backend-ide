const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');

/** Attach a minimal { _id, name } project object to a job (replaces populate). */
async function withProject(job) {
  let project = null;
  if (job.projectId) {
    const p = await prisma.project.findUnique({
      where: { id: job.projectId },
      select: { id: true, name: true }
    });
    if (p) project = { _id: p.id, id: p.id, name: p.name };
  }
  return {
    _id: job.id,
    type: job.type,
    status: job.status,
    project,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

// GET /api/jobs/:id - Get job status
router.get('/:id', async (req, res) => {
  try {
    const job = await prisma.job.findUnique({ where: { id: req.params.id } });

    if (!job) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    res.json({ success: true, job: await withProject(job) });
  } catch (error) {
    console.error('Job fetch error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch job',
      message: error.message
    });
  }
});

// GET /api/jobs - List jobs (optional, for admin/debugging)
router.get('/', async (req, res) => {
  try {
    const { projectId, status, type, limit = 50 } = req.query;

    const where = {};
    if (projectId) where.projectId = projectId;
    if (status) where.status = status;
    if (type) where.type = type;

    const jobs = await prisma.job.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit, 10)
    });

    res.json({
      success: true,
      jobs: await Promise.all(jobs.map(withProject))
    });
  } catch (error) {
    console.error('Jobs list error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch jobs',
      message: error.message
    });
  }
});

module.exports = router;
