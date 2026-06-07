require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const prisma = require('../lib/prisma');

/**
 * Generate invite code format: INV-XXXX-XXXX-XXXX
 */
function generateInviteCode() {
  const segments = [];
  for (let i = 0; i < 3; i++) {
    segments.push(crypto.randomBytes(2).toString('hex').toUpperCase());
  }
  return `INV-${segments.join('-')}`;
}

/**
 * Generate 50 invite codes (Prisma / Postgres).
 */
async function generateInvites() {
  const count = 50;
  const invites = [];
  const errors = [];

  console.log(`Generating ${count} invite codes...`);

  for (let i = 0; i < count; i++) {
    try {
      const email = `invite-${Date.now()}-${i}@placeholder.com`.toLowerCase().trim();

      let invite = await prisma.invite.findFirst({ where: { email } });
      if (!invite) {
        invite = await prisma.invite.create({
          data: { email, inviteCode: generateInviteCode(), sent: false }
        });
      }

      invites.push({
        email: invite.email,
        inviteCode: invite.inviteCode,
        sent: invite.sent,
        used: invite.used
      });

      console.log(`[${i + 1}/${count}] Generated: ${invite.inviteCode} for ${invite.email}`);
    } catch (error) {
      errors.push({ index: i, error: error.message });
      console.error(`Error generating invite ${i + 1}:`, error.message);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Total generated: ${invites.length}`);
  console.log(`Errors: ${errors.length}`);

  const outputFile = 'invites-generated.json';
  fs.writeFileSync(outputFile, JSON.stringify(invites, null, 2));
  console.log(`\nInvites saved to ${outputFile}`);
}

generateInvites()
  .then(async () => {
    await prisma.$disconnect();
    console.log('\nDone!');
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Fatal error:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
