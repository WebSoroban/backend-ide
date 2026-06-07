import type { User as PrismaUser } from '@prisma/client';
import type { Server as SocketIOServer } from 'socket.io';

declare global {
  namespace Express {
    // Passport types declare `req.user` as `Express.User`. Merge the Prisma User
    // shape into it so authenticated handlers see the real user fields.
    interface User extends PrismaUser {}

    // Extra field attached by middleware/auth.ts alongside req.user.
    interface Request {
      userId?: string;
    }
  }

  // The Socket.IO server is stashed on the global for cross-module access.
  // eslint-disable-next-line no-var
  var io: SocketIOServer | null;
}

// Passport strategies that ship no type definitions. Declared loosely so they
// can be imported as constructors without TypeScript errors.
declare module 'passport-discord' {
  export const Strategy: any;
}

declare module 'passport-github2' {
  export const Strategy: any;
}

export {};
