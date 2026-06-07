import * as StellarSdk from '@stellar/stellar-sdk';
import prisma from '../lib/prisma';
import userService from './userService';
import { getTemplateById, PRICE_BY_ID } from '../data/templateCatalog';
import emailService from './emailService';
import receiptService from './receiptService';

// Stellar network configuration
const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK = process.env.PAYMENT_NETWORK || 'testnet';
const PAYMENT_ADDRESS = process.env.PAYMENT_ADDRESS;

interface VerifyResult {
  success: boolean;
  error?: string;
  transaction?: any;
}

class PaymentService {
  server: any;
  useServer: boolean;
  horizonUrl?: string;

  constructor() {
    try {
      // In @stellar/stellar-sdk v13+, Server is under Horizon namespace
      const Server = (StellarSdk as any)?.Horizon?.Server;
      if (Server && typeof Server === 'function') {
        this.server = new Server(HORIZON_URL);
        this.useServer = true;
        console.log('Stellar Server initialized successfully');
      } else {
        console.warn('Stellar Server class not available, using direct Horizon API calls');
        this.server = null;
        this.useServer = false;
        this.horizonUrl = HORIZON_URL;
      }
    } catch (error) {
      console.error('Error initializing Stellar Server:', error);
      this.server = null;
      this.useServer = false;
      this.horizonUrl = HORIZON_URL;
    }
  }

  /**
   * Verify payment transaction
   */
  async verifyPayment(txHash: string, expectedAmount: number | string, memo?: string | null): Promise<VerifyResult> {
    try {
      let transaction: any, operations: any;

      if (this.useServer && this.server) {
        // Use Stellar SDK Server
        transaction = await this.server.transactions().transaction(txHash).call();
        operations = await this.server.operations().forTransaction(txHash).call();
      } else {
        // Use direct Horizon API calls with built-in fetch (Node.js 18+)
        // Node.js 18.20.8 has fetch built-in, use it directly
        const txResponse = await fetch(`${this.horizonUrl}/transactions/${txHash}`);
        if (!txResponse.ok) {
          return {
            success: false,
            error: `Transaction not found: ${txResponse.statusText}`
          };
        }
        transaction = await txResponse.json();

        const opsResponse = await fetch(`${this.horizonUrl}/transactions/${txHash}/operations`);
        if (!opsResponse.ok) {
          return {
            success: false,
            error: `Failed to fetch operations: ${opsResponse.statusText}`
          };
        }
        const opsData: any = await opsResponse.json();
        operations = { records: opsData._embedded.records || [] };
      }

      // Check if transaction is successful
      if (transaction.successful !== true) {
        return {
          success: false,
          error: 'Transaction was not successful'
        };
      }

      // Get payment operation
      const paymentOps = operations.records.filter((op: any) => op.type === 'payment');

      if (paymentOps.length === 0) {
        return {
          success: false,
          error: 'No payment operation found'
        };
      }

      const paymentOp = paymentOps[0];

      // Verify destination
      if (paymentOp.to !== PAYMENT_ADDRESS) {
        return {
          success: false,
          error: 'Payment destination mismatch'
        };
      }

      // Verify amount (allow small variance for fees)
      const receivedAmount = parseFloat(paymentOp.amount);
      const expected = parseFloat(expectedAmount as string);

      if (Math.abs(receivedAmount - expected) > 0.0001) {
        return {
          success: false,
          error: `Amount mismatch. Expected ${expected}, received ${receivedAmount}`
        };
      }

      // Verify memo if provided
      if (memo) {
        // Handle memo from both SDK and direct API responses
        const transactionMemo = transaction.memo_type === 'text'
          ? transaction.memo
          : transaction.memo_type === 'id'
            ? transaction.memo.toString()
            : transaction.memo || null;

        if (transactionMemo && transactionMemo !== memo) {
          return {
            success: false,
            error: 'Memo mismatch'
          };
        }
      }

      // Extract ledger number safely
      let ledgerNumber: number | null = null;
      if (transaction.ledger) {
        if (typeof transaction.ledger === 'number') {
          ledgerNumber = transaction.ledger;
        } else if (typeof transaction.ledger === 'string') {
          ledgerNumber = parseInt(transaction.ledger, 10);
        }
      } else if (transaction.ledger_attr) {
        if (typeof transaction.ledger_attr === 'number') {
          ledgerNumber = transaction.ledger_attr;
        } else if (typeof transaction.ledger_attr === 'string') {
          ledgerNumber = parseInt(transaction.ledger_attr, 10);
        }
      }

      // Validate ledger number
      if (ledgerNumber !== null && (isNaN(ledgerNumber) || !isFinite(ledgerNumber))) {
        ledgerNumber = null;
      }

      return {
        success: true,
        transaction: {
          hash: txHash,
          amount: receivedAmount,
          from: paymentOp.from,
          to: paymentOp.to,
          memo: transaction.memo || null,
          ledger: ledgerNumber,
          createdAt: transaction.created_at || transaction.created_at_attr
        }
      };
    } catch (error: any) {
      console.error('Payment verification error:', error);
      return {
        success: false,
        error: error.message || 'Failed to verify payment'
      };
    }
  }

  /**
   * Process payment and upgrade subscription
   */
  async processPayment(txHash: string, userId: string, plan: string): Promise<any> {
    try {
      // Check if payment already processed
      const existingPayment = await prisma.payment.findUnique({ where: { txHash } });
      if (existingPayment && existingPayment.status === 'confirmed') {
        return {
          success: false,
          error: 'Payment already processed'
        };
      }

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return {
          success: false,
          error: 'User not found'
        };
      }

      const price = plan === 'plan2' ? 50 : 100;
      const memo = userId.toString();

      // Verify payment
      const verification = await this.verifyPayment(txHash, price, memo);

      if (!verification.success) {
        // Create payment record with failed status
        const failedData = {
          userId,
          plan,
          amount: price,
          network: NETWORK,
          fromAddress: verification.transaction?.from || 'unknown',
          toAddress: PAYMENT_ADDRESS,
          status: 'failed',
          verified: false
        };
        await prisma.payment.upsert({
          where: { txHash },
          update: failedData,
          create: { ...failedData, txHash }
        });

        return verification;
      }

      // Create or update payment record
      // Extract ledger number safely
      let ledgerNumber: number | null = null;
      if (verification.transaction && verification.transaction.ledger) {
        const ledger = verification.transaction.ledger;
        // Handle different ledger formats (number, string, or function)
        if (typeof ledger === 'number') {
          ledgerNumber = ledger;
        } else if (typeof ledger === 'string') {
          ledgerNumber = parseInt(ledger, 10);
        } else if (typeof ledger === 'function') {
          // If ledger is a function, try to call it or skip
          try {
            const result = ledger();
            ledgerNumber = typeof result === 'number' ? result : parseInt(String(result), 10);
          } catch (e) {
            console.warn('Could not extract ledger number from function:', e);
            ledgerNumber = null;
          }
        }
      }

      // Ensure ledgerNumber is a valid number or null
      if (ledgerNumber !== null && (isNaN(ledgerNumber) || !isFinite(ledgerNumber))) {
        ledgerNumber = null;
      }

      const confirmedData: any = {
        userId,
        plan,
        amount: price,
        network: NETWORK,
        fromAddress: verification.transaction.from,
        toAddress: verification.transaction.to,
        status: 'confirmed',
        confirmedAt: new Date(),
        ...(ledgerNumber !== null && { blockNumber: ledgerNumber }),
        memo: verification.transaction.memo,
        verified: true,
        verifiedAt: new Date()
      };
      let payment = await prisma.payment.upsert({
        where: { txHash },
        update: confirmedData,
        create: { ...confirmedData, txHash }
      });

      // Find or create subscription
      let subscription = await prisma.subscription.findFirst({
        where: { userId, plan, status: 'active' },
        orderBy: { createdAt: 'desc' }
      });

      if (!subscription) {
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + 30);
        subscription = await prisma.subscription.create({
          data: {
            userId,
            plan,
            status: 'active',
            startDate: new Date(),
            endDate,
            amount: price,
            currency: 'XLM',
            paymentTxHash: txHash,
            paymentNetwork: NETWORK,
            autoRenew: false
          }
        });
      } else {
        // Extend subscription if already active
        let endDate;
        if (subscription.endDate && subscription.endDate > new Date()) {
          endDate = new Date(subscription.endDate);
          endDate.setDate(endDate.getDate() + 30);
        } else {
          endDate = new Date();
          endDate.setDate(endDate.getDate() + 30);
        }
        subscription = await prisma.subscription.update({
          where: { id: subscription.id },
          data: { paymentTxHash: txHash, paymentNetwork: NETWORK, endDate }
        });
      }

      // Update user subscription (denormalized JSON on the user)
      await userService.updateSubscription(userId, plan, txHash);

      // Link payment to subscription
      payment = await prisma.payment.update({
        where: { id: payment.id },
        data: { subscriptionId: subscription.id }
      });

      // Generate and send receipt
      try {
        const receiptData = {
          userEmail: user.email,
          userName: user.name || user.email!.split('@')[0],
          planName: plan === 'plan2' ? 'Pro' : 'Premium',
          planId: plan,
          amount: price,
          currency: 'XLM',
          txHash: txHash,
          network: NETWORK,
          paymentDate: new Date(),
          subscriptionStart: subscription.startDate,
          subscriptionEnd: subscription.endDate
        };

        // Generate PDF receipt
        const pdfPath = await receiptService.generateReceipt(receiptData);

        // Send receipt via email
        if (user.email && user.email !== `${user.walletAddress?.substring(0, 8)}@wallet.local`) {
          await receiptService.sendReceiptEmail(user.email, pdfPath, receiptData);
          console.log(`[PaymentService] Receipt sent to ${user.email}`);
        } else {
          console.warn(`[PaymentService] Cannot send receipt - invalid email: ${user.email}`);
        }
      } catch (receiptError) {
        // Don't fail payment if receipt generation fails
        console.error('[PaymentService] Failed to generate/send receipt:', receiptError);
      }

      return {
        success: true,
        payment,
        subscription,
        message: 'Payment processed and subscription upgraded successfully'
      };
    } catch (error: any) {
      console.error('Process payment error:', error);
      return {
        success: false,
        error: error.message || 'Failed to process payment'
      };
    }
  }

  /**
   * Process template purchase payment (same gateway as plans: XLM to PAYMENT_ADDRESS, memo = purchaseId)
   */
  async processTemplatePayment(txHash: string, purchaseId: string): Promise<any> {
    try {
      const purchase = await prisma.templatePurchase.findUnique({ where: { id: purchaseId } });
      if (!purchase) {
        return { success: false, error: 'Purchase not found' };
      }
      if (purchase.status === 'confirmed') {
        return { success: false, error: 'Template already unlocked for this purchase' };
      }
      if (purchase.status !== 'pending') {
        return { success: false, error: 'Purchase is no longer pending' };
      }

      const expectedAmount = purchase.amount;
      const memo = purchase.memo;

      const verification = await this.verifyPayment(txHash, expectedAmount, memo);
      if (!verification.success) {
        await prisma.templatePurchase.update({ where: { id: purchaseId }, data: { status: 'failed' } });
        return verification;
      }

      await prisma.templatePurchase.update({
        where: { id: purchaseId },
        data: {
          status: 'confirmed',
          txHash,
          confirmedAt: new Date(),
          network: process.env.PAYMENT_NETWORK || 'testnet'
        }
      });

      const user = await prisma.user.findUnique({ where: { id: purchase.userId } });
      if (user && !(user.purchasedTemplates || []).includes(purchase.templateId)) {
        await prisma.user.update({
          where: { id: user.id },
          data: { purchasedTemplates: { push: purchase.templateId } }
        });
      }

      // Send purchase confirmation email (non-blocking)
      try {
        const template = getTemplateById(purchase.templateId);
        const templateName = template ? template.name : purchase.templateId;
        const userEmail = user?.email;
        if (userEmail && userEmail !== `${user?.walletAddress?.substring(0, 8)}@wallet.local`) {
          await emailService.sendTemplatePurchaseNotification(
            userEmail,
            templateName,
            purchase.amount,
            purchase.currency || 'XLM',
            txHash,
            { userName: user?.name || user?.email?.split('@')[0] }
          );
        }
      } catch (emailErr) {
        console.error('[PaymentService] Template purchase email failed:', emailErr);
      }

      return {
        success: true,
        message: 'Template purchase confirmed',
        templateId: purchase.templateId
      };
    } catch (error: any) {
      console.error('Process template payment error:', error);
      return {
        success: false,
        error: error.message || 'Failed to process template payment'
      };
    }
  }

  /**
   * Monitor payments for a user
   */
  async monitorPayments(userId: string, limit = 10): Promise<any> {
    try {
      const payments = await prisma.payment.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: limit
      });

      return {
        success: true,
        payments: payments.map((p) => ({
          _id: p.id,
          plan: p.plan,
          amount: p.amount,
          currency: p.currency,
          txHash: p.txHash,
          network: p.network,
          status: p.status,
          confirmedAt: p.confirmedAt,
          createdAt: p.createdAt
        }))
      };
    } catch (error: any) {
      console.error('Monitor payments error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

export default new PaymentService();
