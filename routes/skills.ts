/**
 * Skills API (mounted at /api/ai/skills).
 *
 * A Skill is a reusable Soroban/Stellar knowledge + instruction pack the Copilot
 * loads as CONTEXT (see services/ai/skills.ts). This router is CRUD + toggle +
 * duplicate + a public library.
 *
 * Isolation: personal skills are owner-scoped — a user only ever sees their own
 * skills plus OFFICIAL skills and PUBLIC skills shared by others. Another user's
 * PRIVATE skill is never returned. Content is validated on save so a skill can
 * shape HOW contracts are written but cannot redefine the assistant or go
 * off-domain (validateSkill enforces in-domain + no role override).
 */
import express, { type Request, type Response } from 'express';
import prisma from '../lib/prisma';
import { authenticate } from '../middleware/auth';
import { rateLimit } from '../middleware/rateLimit';
import { validateSkill, normalizeSlug, type SkillScope } from '../services/ai/skills';

const router = express.Router();

const writeLimiter = rateLimit({ windowSec: 60, max: 40, prefix: 'skills-write' });

/** Shape returned to the client (never leaks another user's private skill). */
function serializeSkill(s: any, userId: string, prefEnabled?: boolean) {
  const owned = s.ownerId === userId;
  // Effective enabled: owner's column for own skills; per-user preference (default
  // the skill's own default) for official/public skills.
  const enabled = owned ? s.enabled : prefEnabled ?? s.enabled;
  return {
    _id: s.id,
    id: s.id,
    name: s.name,
    slug: s.slug,
    description: s.description,
    whenToUse: s.whenToUse,
    body: s.body,
    scope: s.scope as SkillScope,
    visibility: s.visibility,
    official: s.official,
    owned,
    editable: owned, // official/public-not-owned are read-only (duplicate to edit)
    enabled,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** Find a slug not already used by this owner (append -2, -3, … if needed). */
async function uniqueSlugForOwner(ownerId: string, base: string): Promise<string> {
  let slug = base || 'skill';
  for (let i = 1; i < 50; i++) {
    const exists = await prisma.skill.findFirst({ where: { ownerId, slug } });
    if (!exists) return slug;
    slug = `${base}-${i + 1}`;
  }
  return `${base}-${Date.now()}`;
}

// GET /api/ai/skills — the user's skills (personal) + official + public-from-others,
// each with its effective enabled state. ?library=1 returns ONLY public skills the
// user doesn't own (the browse-able library).
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const libraryOnly = req.query.library === '1';

    const [own, shared, prefs] = await Promise.all([
      libraryOnly ? Promise.resolve([]) : prisma.skill.findMany({ where: { ownerId: userId }, orderBy: { updatedAt: 'desc' } }),
      // Official packs (ownerId IS NULL) + PUBLIC skills owned by OTHER users.
      // NOTE: can't use `NOT: { ownerId: userId }` — in SQL `NOT(ownerId = userId)`
      // is NULL (excluded) for the null-owner official rows. Match each branch
      // explicitly so official skills always show.
      prisma.skill.findMany({
        where: {
          OR: [
            { official: true },
            { AND: [{ visibility: 'public' }, { ownerId: { not: null } }, { ownerId: { not: userId } }] },
          ],
        },
        orderBy: [{ official: 'desc' }, { updatedAt: 'desc' }],
      }),
      prisma.skillPreference.findMany({ where: { userId } }),
    ]);

    const prefById = new Map(prefs.map((p) => [p.skillId, p.enabled]));
    const skills = [
      ...own.map((s) => serializeSkill(s, userId)),
      ...shared.map((s) => serializeSkill(s, userId, prefById.get(s.id))),
    ];
    res.json({ skills });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to list skills', message: error.message });
  }
});

// GET /api/ai/skills/:id — a single skill (own, official, or public).
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const s = await prisma.skill.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Skill not found' });
    const accessible = s.ownerId === userId || s.official || s.visibility === 'public';
    if (!accessible) return res.status(403).json({ error: 'Forbidden' });
    const pref = s.ownerId === userId ? undefined : (await prisma.skillPreference.findUnique({ where: { userId_skillId: { userId, skillId: s.id } } }))?.enabled;
    res.json(serializeSkill(s, userId, pref));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to load skill', message: error.message });
  }
});

// POST /api/ai/skills — create a personal skill (validated, in-domain).
router.post('/', authenticate, writeLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const v = validateSkill(req.body || {});
    if (!v.ok) return res.status(400).json({ error: 'OUT_OF_SCOPE_SKILL', message: v.reason });

    const slug = await uniqueSlugForOwner(userId, v.value!.slug);
    const created = await prisma.skill.create({
      data: {
        ownerId: userId,
        official: false,
        name: v.value!.name,
        slug,
        description: v.value!.description,
        whenToUse: v.value!.whenToUse,
        body: v.value!.body,
        scope: v.value!.scope,
        visibility: v.value!.visibility,
        enabled: true,
      },
    });
    res.status(201).json(serializeSkill(created, userId));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to create skill', message: error.message });
  }
});

// PUT /api/ai/skills/:id — edit an OWNED skill (official/public-not-owned are read-only).
router.put('/:id', authenticate, writeLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const existing = await prisma.skill.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Skill not found' });
    if (existing.ownerId !== userId) {
      return res.status(403).json({ error: 'You can only edit your own skills. Duplicate this one to customize it.' });
    }
    const v = validateSkill({
      name: req.body.name ?? existing.name,
      description: req.body.description ?? existing.description,
      whenToUse: req.body.whenToUse ?? existing.whenToUse,
      body: req.body.body ?? existing.body,
      scope: req.body.scope ?? existing.scope,
      visibility: req.body.visibility ?? existing.visibility,
    });
    if (!v.ok) return res.status(400).json({ error: 'OUT_OF_SCOPE_SKILL', message: v.reason });

    // Keep the slug stable unless the name changed to a new slug that's free.
    let slug = existing.slug;
    if (v.value!.slug !== existing.slug) slug = await uniqueSlugForOwner(userId, v.value!.slug);

    const updated = await prisma.skill.update({
      where: { id: existing.id },
      data: {
        name: v.value!.name,
        slug,
        description: v.value!.description,
        whenToUse: v.value!.whenToUse,
        body: v.value!.body,
        scope: v.value!.scope,
        visibility: v.value!.visibility,
      },
    });
    res.json(serializeSkill(updated, userId));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to update skill', message: error.message });
  }
});

// DELETE /api/ai/skills/:id — delete an OWNED skill (cannot delete official/others').
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const existing = await prisma.skill.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Skill not found' });
    if (existing.ownerId !== userId) return res.status(403).json({ error: 'You can only delete your own skills.' });
    await prisma.skill.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to delete skill', message: error.message });
  }
});

// POST /api/ai/skills/:id/toggle — enable/disable for THIS user.
// body: { enabled: boolean }. Own skills flip Skill.enabled; official/public ones
// upsert a per-user SkillPreference so the shared row is untouched.
router.post('/:id/toggle', authenticate, writeLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const enabled = req.body.enabled !== false; // default true
    const s = await prisma.skill.findUnique({ where: { id: req.params.id } });
    if (!s) return res.status(404).json({ error: 'Skill not found' });
    const accessible = s.ownerId === userId || s.official || s.visibility === 'public';
    if (!accessible) return res.status(403).json({ error: 'Forbidden' });

    if (s.ownerId === userId) {
      const updated = await prisma.skill.update({ where: { id: s.id }, data: { enabled } });
      return res.json(serializeSkill(updated, userId));
    }
    await prisma.skillPreference.upsert({
      where: { userId_skillId: { userId, skillId: s.id } },
      update: { enabled },
      create: { userId, skillId: s.id, enabled },
    });
    res.json(serializeSkill(s, userId, enabled));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to toggle skill', message: error.message });
  }
});

// POST /api/ai/skills/:id/duplicate — copy an official/public (or own) skill into
// the user's own editable skill.
router.post('/:id/duplicate', authenticate, writeLimiter, async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const src = await prisma.skill.findUnique({ where: { id: req.params.id } });
    if (!src) return res.status(404).json({ error: 'Skill not found' });
    const accessible = src.ownerId === userId || src.official || src.visibility === 'public';
    if (!accessible) return res.status(403).json({ error: 'Forbidden' });

    const baseName = `${src.name} (copy)`.slice(0, 80);
    const slug = await uniqueSlugForOwner(userId, normalizeSlug(baseName));
    const copy = await prisma.skill.create({
      data: {
        ownerId: userId,
        official: false,
        name: baseName,
        slug,
        description: src.description,
        whenToUse: src.whenToUse,
        body: src.body,
        scope: src.scope,
        visibility: 'private',
        enabled: true,
      },
    });
    res.status(201).json(serializeSkill(copy, userId));
  } catch (error: any) {
    res.status(500).json({ error: 'Failed to duplicate skill', message: error.message });
  }
});

export default router;
