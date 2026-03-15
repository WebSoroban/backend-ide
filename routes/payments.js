const express = require('express');
const router = express.Router();
const Payment = require('../models/Payment');
const paymentService = require('../services/paymentService');
const { authenticate } = require('../middleware/auth');

/**
 * POST /api/payments/verify
 * Verify payment transaction
 */
router.post('/verify', authenticate, async (req, res) => {
  try {
    const { txHash, plan } = req.body;
    const user = req.user;
    
    if (!txHash || !plan) {
      return res.status(400).json({
        success: false,
        error: 'Transaction hash and plan are required'
      });
    }
    
    if (!['plan2', 'plan3'].includes(plan)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid plan'
      });
    }
    
    const price = plan === 'plan2' ? 50 : 100;
    const memo = user._id.toString();
    
    // Process payment
    const result = await paymentService.processPayment(txHash, user._id, plan);
    
    if (result.success) {
      // Refresh user data
      await user.populate('subscription');
      
      res.json({
        success: true,
        message: result.message,
        payment: {
          txHash: result.payment.txHash,
          status: result.payment.status,
          amount: result.payment.amount
        },
        subscription: {
          plan: user.subscription.plan,
          status: user.subscription.status,
          endDate: user.subscription.endDate
        }
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error
      });
    }
  } catch (error) {
    console.error('Verify payment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify payment',
      message: error.message
    });
  }
});

/**
 * POST /api/payments/verify-template
 * Verify template purchase payment (same XLM gateway as plans)
 */
router.post('/verify-template', authenticate, async (req, res) => {
  try {
    const { txHash, purchaseId } = req.body;
    const user = req.user;

    if (!txHash || !purchaseId) {
      return res.status(400).json({
        success: false,
        error: 'Transaction hash and purchaseId are required'
      });
    }

    const result = await paymentService.processTemplatePayment(txHash, purchaseId);

    if (result.success) {
      // Refresh user to get updated purchasedTemplates
      const updatedUser = await require('../models/User').findById(user._id);
      return res.json({
        success: true,
        message: result.message,
        templateId: result.templateId,
        purchasedTemplates: updatedUser?.purchasedTemplates || []
      });
    }

    res.status(400).json({
      success: false,
      error: result.error
    });
  } catch (error) {
    console.error('Verify template payment error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify template payment',
      message: error.message
    });
  }
});

/**
 * GET /api/payments/history
 * Get payment history for current user
 */
router.get('/history', authenticate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const result = await paymentService.monitorPayments(req.user._id, limit);
    
    if (result.success) {
      res.json({
        success: true,
        payments: result.payments
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error
      });
    }
  } catch (error) {
    console.error('Get payment history error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get payment history',
      message: error.message
    });
  }
});

/**
 * GET /api/payments/all
 * Get recent payment transactions for all users (platform-wide for analytics)
 */
router.get('/all', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const payments = await Payment.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('userId', 'email name')
      .lean();

    const list = payments.map((p) => ({
      _id: p._id,
      plan: p.plan,
      amount: p.amount,
      currency: p.currency,
      txHash: p.txHash,
      network: p.network,
      status: p.status,
      fromAddress: p.fromAddress,
      toAddress: p.toAddress,
      confirmedAt: p.confirmedAt,
      createdAt: p.createdAt,
      user: p.userId ? { email: p.userId.email, name: p.userId.name || null } : null
    }));

    res.json({ success: true, payments: list });
  } catch (error) {
    console.error('Get all payments error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get transaction history',
      message: error.message
    });
  }
});

module.exports = router;
