-- CreateTable
CREATE TABLE "PayLoopPolicy" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "policyId" BIGINT NOT NULL,
    "subscriber" TEXT NOT NULL,
    "merchant" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "intervalSeconds" INTEGER NOT NULL,
    "cap" TEXT NOT NULL,
    "spent" TEXT NOT NULL,
    "charges" INTEGER NOT NULL,
    "failedAttempts" INTEGER NOT NULL,
    "nextChargeAt" TIMESTAMP(3) NOT NULL,
    "chainCreatedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "lastAttemptAt" TIMESTAMP(3),
    "lastAttemptError" TEXT,
    "syncedLedger" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayLoopPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayLoopCharge" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "policyId" BIGINT NOT NULL,
    "eventId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "ledgerClosedAt" TIMESTAMP(3) NOT NULL,
    "outcome" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "chargeNumber" INTEGER,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "delaySeconds" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayLoopCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayLoopSyncState" (
    "contractId" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "cursor" TEXT,
    "lastLedger" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayLoopSyncState_pkey" PRIMARY KEY ("contractId")
);

-- CreateIndex
CREATE INDEX "PayLoopPolicy_contractId_status_nextChargeAt_idx" ON "PayLoopPolicy"("contractId", "status", "nextChargeAt");

-- CreateIndex
CREATE INDEX "PayLoopPolicy_subscriber_idx" ON "PayLoopPolicy"("subscriber");

-- CreateIndex
CREATE INDEX "PayLoopPolicy_merchant_idx" ON "PayLoopPolicy"("merchant");

-- CreateIndex
CREATE UNIQUE INDEX "PayLoopPolicy_contractId_policyId_key" ON "PayLoopPolicy"("contractId", "policyId");

-- CreateIndex
CREATE UNIQUE INDEX "PayLoopCharge_eventId_key" ON "PayLoopCharge"("eventId");

-- CreateIndex
CREATE INDEX "PayLoopCharge_contractId_policyId_ledger_idx" ON "PayLoopCharge"("contractId", "policyId", "ledger");

-- CreateIndex
CREATE INDEX "PayLoopCharge_contractId_outcome_ledgerClosedAt_idx" ON "PayLoopCharge"("contractId", "outcome", "ledgerClosedAt");

-- AddForeignKey
ALTER TABLE "PayLoopCharge" ADD CONSTRAINT "PayLoopCharge_contractId_policyId_fkey" FOREIGN KEY ("contractId", "policyId") REFERENCES "PayLoopPolicy"("contractId", "policyId") ON DELETE CASCADE ON UPDATE CASCADE;

