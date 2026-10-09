-- CreateTable
CREATE TABLE "X402Webhook" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpointId" TEXT,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secretEncrypted" TEXT NOT NULL,
    "secretPrefix" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "X402Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "X402WebhookDelivery" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "X402WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "X402AgentWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpointId" TEXT,
    "name" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "spendLimitUsdc" TEXT NOT NULL,
    "limitStroops" TEXT NOT NULL,
    "spentStroops" TEXT NOT NULL DEFAULT '0',
    "periodSeconds" INTEGER NOT NULL DEFAULT 86400,
    "periodLedgers" INTEGER NOT NULL DEFAULT 17280,
    "windowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "asset" TEXT NOT NULL DEFAULT 'USDC',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "X402AgentWallet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "X402Webhook_userId_createdAt_idx" ON "X402Webhook"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "X402Webhook_endpointId_idx" ON "X402Webhook"("endpointId");

-- CreateIndex
CREATE INDEX "X402WebhookDelivery_webhookId_createdAt_idx" ON "X402WebhookDelivery"("webhookId", "createdAt");

-- CreateIndex
CREATE INDEX "X402WebhookDelivery_status_nextAttemptAt_idx" ON "X402WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "X402AgentWallet_userId_createdAt_idx" ON "X402AgentWallet"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "X402AgentWallet_publicKey_idx" ON "X402AgentWallet"("publicKey");

-- CreateIndex
CREATE INDEX "X402AgentWallet_endpointId_idx" ON "X402AgentWallet"("endpointId");

-- AddForeignKey
ALTER TABLE "X402Webhook" ADD CONSTRAINT "X402Webhook_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "X402Webhook" ADD CONSTRAINT "X402Webhook_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "X402Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "X402WebhookDelivery" ADD CONSTRAINT "X402WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "X402Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "X402AgentWallet" ADD CONSTRAINT "X402AgentWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "X402AgentWallet" ADD CONSTRAINT "X402AgentWallet_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "X402Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
