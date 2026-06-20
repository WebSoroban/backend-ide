-- Mainnet support: per-network fields, mainnet signing mode, key-export audit.
--
-- A contract deployed on testnet is distinct from one on mainnet. Existing rows
-- default to "testnet", so every current project/invocation is unchanged.
-- Self-contained: `prisma migrate deploy` is enough.

-- AlterTable: Project keeps its "current deploy" pointer; record its network.
ALTER TABLE "Project" ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';

-- AlterTable: Invocation records which network the call ran on.
ALTER TABLE "Invocation" ADD COLUMN "network" TEXT NOT NULL DEFAULT 'testnet';

-- AlterTable: Wallet — how mainnet signs ("connected" non-custodial default).
ALTER TABLE "Wallet" ADD COLUMN "mainnetSigningMode" TEXT NOT NULL DEFAULT 'connected';

-- CreateTable: KeyExportAudit (never stores the key — just the access event).
CREATE TABLE "KeyExportAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeyExportAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KeyExportAudit_userId_createdAt_idx" ON "KeyExportAudit"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "KeyExportAudit" ADD CONSTRAINT "KeyExportAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
