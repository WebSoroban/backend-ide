import 'dotenv/config';
import prisma from '../lib/prisma';
import { seedOfficialSkills, OFFICIAL_SKILLS } from '../services/ai/skillSeeds';

/**
 * Seed (or refresh) the OFFICIAL Copilot skills (ownerId null, official=true).
 * Idempotent: upserts by (official, slug), so re-running updates bodies in place.
 *
 * Run: npm run seed:skills
 */
async function main() {
  console.log(`Seeding ${OFFICIAL_SKILLS.length} official skills…`);
  const { created, updated } = await seedOfficialSkills();
  console.log(`Done. created=${created}, updated=${updated}`);
  for (const s of OFFICIAL_SKILLS) console.log(`  - @skill:${s.slug} (${s.scope}) — ${s.name}`);
}

main()
  .catch((e) => {
    console.error('Skill seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
