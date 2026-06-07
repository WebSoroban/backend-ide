/**
 * Singleton Prisma client.
 *
 * Reused across the API server and the BullMQ workers. Cached on globalThis so
 * nodemon / repeated requires don't open new connection pools each reload.
 */
const { PrismaClient } = require('@prisma/client');

const globalForPrisma = globalThis;

const prisma =
  globalForPrisma.__prisma ||
  new PrismaClient({
    log: process.env.PRISMA_LOG === 'true' ? ['query', 'warn', 'error'] : ['warn', 'error']
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

module.exports = prisma;
module.exports.prisma = prisma;
