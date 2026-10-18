/**
 * Idea Bank API (mounted at /api/ideas).
 *
 *   POST  /submissions       anyone — submit an idea (stored as pending)
 *   GET   /                  anyone — accepted ideas for the public Idea Bank
 *   GET   /submissions       admin  — review queue, ?status=pending|accepted|rejected|all
 *   PATCH /submissions/:id   admin  — accept or reject, optionally editing the copy first
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import prisma from '../lib/prisma';
import { authenticate, optionalAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/admin';
import { rateLimit } from '../middleware/rateLimit';
import { adminIdea, isIdeaStatus, publicIdea, validateIdea, type IdeaFields } from '../services/ideaSubmissions';

const router = express.Router();

const asyncRoute = (
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) => (req: Request, res: Response, next: NextFunction) => {
  void Promise.resolve(handler(req, res, next)).catch(next);
};

// The API sits behind a proxy without `trust proxy`, so key anonymous callers by
// the first forwarded address instead of the proxy's own IP.
const clientKey = (req: Request) =>
  req.userId || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip;

const submitLimiter = rateLimit({ windowSec: 60 * 60, max: 5, prefix: 'ideas-submit', keyFor: clientKey });

router.post('/submissions', optionalAuth, submitLimiter, asyncRoute(async (req: Request, res: Response) => {
  // Honeypot: real visitors never see this field, so a filled one is a bot. Answer
  // as if it worked so the bot has nothing to learn from.
  if (typeof req.body?.website === 'string' && req.body.website.trim()) {
    return res.status(201).json({ success: true });
  }

  const result = validateIdea(req.body);
  if ('error' in result) {
    return res.status(400).json({ success: false, error: result.error, field: result.field });
  }

  const idea = await prisma.ideaSubmission.create({
    data: { ...(result.value as IdeaFields), userId: req.userId ?? null },
  });
  res.status(201).json({ success: true, id: idea.id });
}));

router.get('/', asyncRoute(async (_req: Request, res: Response) => {
  const rows = await prisma.ideaSubmission.findMany({
    where: { status: 'accepted' },
    orderBy: { reviewedAt: 'asc' },
    take: 200,
  });
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  res.json({ success: true, ideas: rows.map(publicIdea) });
}));

router.get('/submissions', authenticate, requireAdmin, asyncRoute(async (req: Request, res: Response) => {
  const status = String(req.query.status || 'pending');
  if (status !== 'all' && !isIdeaStatus(status)) {
    return res.status(400).json({ success: false, error: 'Status must be pending, accepted, rejected, or all.' });
  }
  const rows = await prisma.ideaSubmission.findMany({
    where: status === 'all' ? {} : { status },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({ success: true, submissions: rows.map(adminIdea) });
}));

router.patch('/submissions/:id', authenticate, requireAdmin, asyncRoute(async (req: Request, res: Response) => {
  const status = req.body?.status;
  if (status !== undefined && !isIdeaStatus(status)) {
    return res.status(400).json({ success: false, error: 'Status must be pending, accepted, or rejected.' });
  }

  // Admins can tidy the copy before showcasing it; edits go through the same rules.
  const edits = validateIdea(req.body?.edits, { partial: true });
  if ('error' in edits) {
    return res.status(400).json({ success: false, error: edits.error, field: edits.field });
  }

  const existing = await prisma.ideaSubmission.findUnique({ where: { id: req.params.id } });
  if (!existing) return res.status(404).json({ success: false, error: 'Submission was not found.' });

  const idea = await prisma.ideaSubmission.update({
    where: { id: existing.id },
    data: {
      ...edits.value,
      ...(typeof req.body?.reviewNote === 'string' ? { reviewNote: req.body.reviewNote.trim().slice(0, 1000) } : {}),
      ...(status && status !== existing.status
        ? { status, reviewedBy: req.user!.email, reviewedAt: status === 'pending' ? null : new Date() }
        : {}),
    },
  });
  res.json({ success: true, submission: adminIdea(idea) });
}));

export default router;
