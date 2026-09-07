-- CreateTable
CREATE TABLE "X402Endpoint" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'GET',
    "price" TEXT NOT NULL,
    "asset" TEXT NOT NULL DEFAULT 'USDC',
    "network" TEXT NOT NULL DEFAULT 'stellar:testnet',
    "payTo" TEXT NOT NULL,
    "responseBody" JSONB NOT NULL DEFAULT '{"message":"Paid access granted."}',
    "apiKeyHash" TEXT NOT NULL,
    "apiKeyPrefix" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "X402Endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "X402Event" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestFingerprint" TEXT,
    "transaction" TEXT,
    "payer" TEXT,
    "amount" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "latencyMs" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "X402Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "X402Endpoint_slug_key" ON "X402Endpoint"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "X402Endpoint_apiKeyHash_key" ON "X402Endpoint"("apiKeyHash");

-- CreateIndex
CREATE INDEX "X402Endpoint_userId_updatedAt_idx" ON "X402Endpoint"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "X402Endpoint_projectId_idx" ON "X402Endpoint"("projectId");

-- CreateIndex
CREATE INDEX "X402Endpoint_active_idx" ON "X402Endpoint"("active");

-- CreateIndex
CREATE INDEX "X402Event_endpointId_createdAt_idx" ON "X402Event"("endpointId", "createdAt");

-- CreateIndex
CREATE INDEX "X402Event_endpointId_status_createdAt_idx" ON "X402Event"("endpointId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "X402Event_transaction_idx" ON "X402Event"("transaction");

-- AddForeignKey
ALTER TABLE "X402Endpoint" ADD CONSTRAINT "X402Endpoint_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "X402Endpoint" ADD CONSTRAINT "X402Endpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "X402Event" ADD CONSTRAINT "X402Event_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "X402Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
