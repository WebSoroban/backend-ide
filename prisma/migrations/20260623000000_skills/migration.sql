-- Copilot Skills: user-authored (or OFFICIAL) Soroban/Stellar knowledge + instruction
-- packs the Copilot loads as context with progressive disclosure (index always,
-- body on demand). Skill bodies are GUIDANCE/DATA — they cannot widen the
-- Soroban-only scope, the file-type allowlist, or the safety rules (enforced in
-- the harness guardrail layer + validated on save).
--
-- Skill            — the pack itself; ownerId null => official (seeded, global).
-- SkillPreference  — per-user enable/disable of official/public skills the user
--                    does not own (owners toggle their own via Skill.enabled).
-- Self-contained: `prisma migrate deploy` is enough.

-- CreateTable
CREATE TABLE "Skill" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT,
    "official" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "whenToUse" TEXT NOT NULL DEFAULT '',
    "body" TEXT NOT NULL DEFAULT '',
    "scope" TEXT NOT NULL DEFAULT 'auto',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "visibility" TEXT NOT NULL DEFAULT 'private',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SkillPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SkillPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Skill_ownerId_enabled_idx" ON "Skill"("ownerId", "enabled");

-- CreateIndex
CREATE INDEX "Skill_official_enabled_idx" ON "Skill"("official", "enabled");

-- CreateIndex
CREATE INDEX "Skill_visibility_idx" ON "Skill"("visibility");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_ownerId_slug_key" ON "Skill"("ownerId", "slug");

-- CreateIndex
CREATE INDEX "SkillPreference_userId_idx" ON "SkillPreference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SkillPreference_userId_skillId_key" ON "SkillPreference"("userId", "skillId");

-- AddForeignKey
ALTER TABLE "Skill" ADD CONSTRAINT "Skill_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillPreference" ADD CONSTRAINT "SkillPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SkillPreference" ADD CONSTRAINT "SkillPreference_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
