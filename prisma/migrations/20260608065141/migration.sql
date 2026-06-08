-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "spec" JSONB,
ADD COLUMN     "wasmHash" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "spec" JSONB,
ADD COLUMN     "wasmHash" TEXT;

-- CreateTable
CREATE TABLE "Invocation" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "userId" TEXT,
    "projectId" TEXT,
    "functionName" TEXT NOT NULL,
    "args" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "readOnly" BOOLEAN NOT NULL DEFAULT false,
    "txHash" TEXT,
    "returnValue" JSONB,
    "resourceFee" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FunctionTest" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "functionName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "args" JSONB NOT NULL DEFAULT '{}',
    "expected" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FunctionTest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Invocation_contractId_createdAt_idx" ON "Invocation"("contractId", "createdAt");

-- CreateIndex
CREATE INDEX "Invocation_userId_createdAt_idx" ON "Invocation"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "FunctionTest_userId_contractId_functionName_idx" ON "FunctionTest"("userId", "contractId", "functionName");

-- AddForeignKey
ALTER TABLE "Invocation" ADD CONSTRAINT "Invocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FunctionTest" ADD CONSTRAINT "FunctionTest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
