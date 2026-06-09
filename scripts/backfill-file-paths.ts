import 'dotenv/config';
import prisma from '../lib/prisma';
import { legacyNameToPath, baseName } from '../lib/paths';

/**
 * Data backfill for multi-file support.
 *
 * Populates File.path for any project whose files still lack a tree path, using
 * the SAME flat->tree mapping the build worker historically applied
 * (lib/paths.ts#legacyNameToPath). The 20260609000000_multifile_paths migration
 * already backfills paths in SQL, so on an up-to-date database this script is a
 * no-op; it exists to (a) document the mapping in TS, and (b) repair projects
 * created by older code paths that may have empty/duplicate paths.
 *
 * Idempotent and safe to re-run. Run with:  npm run backfill:file-paths
 */
async function backfillFilePaths() {
  const projects = await prisma.project.findMany({
    select: { id: true, name: true, files: { select: { id: true, name: true, path: true } } }
  });

  console.log(`[backfill] scanning ${projects.length} projects…`);
  let updated = 0;
  let skipped = 0;

  for (const project of projects) {
    // Compute desired path per file, de-duping collisions within the project.
    const used = new Set<string>();
    // Seed with already-valid paths so we don't collide with them.
    for (const f of project.files) {
      if (f.path && f.path.trim()) used.add(f.path);
    }

    for (const f of project.files) {
      if (f.path && f.path.trim()) {
        skipped++;
        continue;
      }
      let desired = legacyNameToPath(f.name || f.id);
      if (!desired) desired = `src/${f.id}.rs`;
      if (used.has(desired)) {
        let n = 2;
        while (used.has(`dup${n}/${desired}`)) n++;
        desired = `dup${n}/${desired}`;
      }
      used.add(desired);

      await prisma.file.update({
        where: { id: f.id },
        // Keep `name` as the leaf so the tree UI and tabs are consistent.
        data: { path: desired, name: baseName(desired) }
      });
      updated++;
    }
  }

  console.log(`[backfill] done — ${updated} files updated, ${skipped} already had a path.`);
}

backfillFilePaths()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error('[backfill] failed:', err);
    await prisma.$disconnect();
    process.exit(1);
  });
