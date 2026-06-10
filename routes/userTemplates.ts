import express, { type Request, type Response } from 'express';
import prisma from '../lib/prisma';
import { authenticate } from '../middleware/auth';

const router = express.Router();

// A saved template can hold a full multi-file bundle; cap sizes so a single row
// can't blow past sane Postgres JSON limits or be used to exhaust storage.
const MAX_TEMPLATES_PER_USER = 100;
const MAX_BUNDLE_BYTES = 512 * 1024; // 512 KB of generated source is plenty.
const VALID_ENGINES = new Set(['oz', 'internal']);

interface BundleFile {
  path: string;
  content: string;
}

interface ResolvedBundle {
  files: BundleFile[];
  manifestPath: string;
  deployTarget: string | null;
}

/**
 * Validate the resolved bundle we persist + later scaffold from.
 * Returns the cleaned ResolvedBundle, or an error message string.
 */
function validateBundle(bundle: any): ResolvedBundle | string {
  if (!bundle || typeof bundle !== 'object') return 'bundle is required';
  const { files, manifestPath, deployTarget } = bundle;
  if (!Array.isArray(files) || files.length === 0) return 'bundle.files must be a non-empty array';
  if (files.length > 200) return 'bundle has too many files';
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
      return 'each bundle file needs string path + content';
    }
  }
  if (typeof manifestPath !== 'string' || !manifestPath) return 'bundle.manifestPath is required';
  const size = files.reduce((n: number, f: BundleFile) => n + f.path.length + f.content.length, 0);
  if (size > MAX_BUNDLE_BYTES) return 'bundle is too large';
  return {
    files: files.map((f: BundleFile) => ({ path: f.path, content: f.content })),
    manifestPath,
    deployTarget: typeof deployTarget === 'string' && deployTarget ? deployTarget : null,
  };
}

function serialize(t: any) {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    engine: t.engine,
    config: t.config,
    bundle: t.bundle,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// GET /api/user-templates — list the signed-in user's saved wizard templates.
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const templates = await prisma.userTemplate.findMany({
      where: { userId: req.userId! },
      orderBy: { updatedAt: 'desc' },
    });
    res.json(templates.map(serialize));
  } catch (error) {
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

// GET /api/user-templates/:id — one saved template (config restores wizard state).
router.get('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const template = await prisma.userTemplate.findFirst({
      where: { id: req.params.id, userId: req.userId! },
    });
    if (!template) return res.status(404).json({ error: 'Template not found' });
    res.json(serialize(template));
  } catch (error) {
    res.status(500).json({ error: 'Failed to load template' });
  }
});

// POST /api/user-templates — save a wizard design ({ name, type, engine, config, bundle }).
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const { name, type, engine, config, bundle } = req.body;
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name is required' });
    if (typeof type !== 'string' || !type.trim()) return res.status(400).json({ error: 'type is required' });
    if (typeof engine !== 'string' || !VALID_ENGINES.has(engine)) return res.status(400).json({ error: 'engine must be "oz" or "internal"' });

    const v = validateBundle(bundle);
    if (typeof v === 'string') return res.status(400).json({ error: v });

    const count = await prisma.userTemplate.count({ where: { userId: req.userId! } });
    if (count >= MAX_TEMPLATES_PER_USER) {
      return res.status(403).json({ error: `You can save up to ${MAX_TEMPLATES_PER_USER} templates. Delete one to make room.` });
    }

    const created = await prisma.userTemplate.create({
      data: {
        userId: req.userId!,
        name: name.trim().slice(0, 100),
        type: type.trim().slice(0, 60),
        engine,
        config: config && typeof config === 'object' ? config : {},
        bundle: v as any,
      },
    });
    res.status(201).json(serialize(created));
  } catch (error) {
    res.status(500).json({ error: 'Failed to save template' });
  }
});

// PUT /api/user-templates/:id — overwrite a saved template (re-customise + re-save).
router.put('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const existing = await prisma.userTemplate.findFirst({
      where: { id: req.params.id, userId: req.userId! },
    });
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    const { name, type, engine, config, bundle } = req.body;
    const data: any = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name must be a non-empty string' });
      data.name = name.trim().slice(0, 100);
    }
    if (type !== undefined) data.type = String(type).slice(0, 60);
    if (engine !== undefined) {
      if (!VALID_ENGINES.has(engine)) return res.status(400).json({ error: 'engine must be "oz" or "internal"' });
      data.engine = engine;
    }
    if (config !== undefined) data.config = config && typeof config === 'object' ? config : {};
    if (bundle !== undefined) {
      const v = validateBundle(bundle);
      if (typeof v === 'string') return res.status(400).json({ error: v });
      data.bundle = v as any;
    }

    const updated = await prisma.userTemplate.update({ where: { id: existing.id }, data });
    res.json(serialize(updated));
  } catch (error) {
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// DELETE /api/user-templates/:id
router.delete('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const result = await prisma.userTemplate.deleteMany({
      where: { id: req.params.id, userId: req.userId! },
    });
    if (result.count === 0) return res.status(404).json({ error: 'Template not found' });
    res.status(204).end();
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

export default router;
