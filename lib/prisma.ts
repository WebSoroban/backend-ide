/**
 * Singleton Prisma client.
 *
 * Reused across the API server and the BullMQ workers. Cached on globalThis so
 * nodemon / repeated requires don't open new connection pools each reload.
 */
import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as typeof globalThis & {
  __prisma?: PrismaClient;
};

const prisma: PrismaClient =
  globalForPrisma.__prisma ||
  new PrismaClient({
    log: process.env.PRISMA_LOG === 'true' ? ['query', 'warn', 'error'] : ['warn', 'error']
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__prisma = prisma;
}

export default prisma;
export { prisma };
