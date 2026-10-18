-- Idea Bank submissions: anyone can submit an idea, admins accept or reject it,
-- and only accepted rows are served publicly. Self-contained: `prisma migrate deploy` is enough.

-- CreateTable
CREATE TABLE "IdeaSubmission" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "alignment" TEXT NOT NULL DEFAULT '',
    "author" TEXT NOT NULL,
    "contact" TEXT NOT NULL DEFAULT '',
    "link" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewNote" TEXT NOT NULL DEFAULT '',
    "userId" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdeaSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IdeaSubmission_status_createdAt_idx" ON "IdeaSubmission"("status", "createdAt");
