-- Contract customisation wizard: saved user templates.
--
-- A UserTemplate stores the wizard state (`config`) and the resolved multi-file
-- bundle (`bundle` = { files, manifestPath, deployTarget }) so a saved design
-- can both be re-opened/re-customised and scaffolded into a new project without
-- re-running the generator. Self-contained: `prisma migrate deploy` is enough.

-- CreateTable
CREATE TABLE "UserTemplate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "bundle" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserTemplate_userId_idx" ON "UserTemplate"("userId");

-- CreateIndex
CREATE INDEX "UserTemplate_userId_updatedAt_idx" ON "UserTemplate"("userId", "updatedAt");

-- AddForeignKey
ALTER TABLE "UserTemplate" ADD CONSTRAINT "UserTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
