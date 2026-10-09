-- AlterTable
ALTER TABLE "X402WebhookDelivery" ADD COLUMN     "deliveredAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "X402SpendReservation" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "amountStroops" TEXT NOT NULL,
    "windowStartedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "X402SpendReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "X402SpendReservation_fingerprint_key" ON "X402SpendReservation"("fingerprint");

-- CreateIndex
CREATE INDEX "X402SpendReservation_walletId_status_idx" ON "X402SpendReservation"("walletId", "status");

-- AddForeignKey
ALTER TABLE "X402SpendReservation" ADD CONSTRAINT "X402SpendReservation_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "X402AgentWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

