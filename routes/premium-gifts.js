const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const userService = require('../services/userService');
const { authenticate } = require('../middleware/auth');
const emailService = require('../services/emailService');

/**
 * Gift / extend a plan3 (Premium) subscription for an email.
 * Creates the user if they don't exist. Returns { user, isNewUser, emailResult }.
 */
async function giftPremium(normalizedEmail, duration) {
  let user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  const isNewUser = !user;

  // Compute the new end date (extend if an active premium term is still running).
  let endDate = new Date();
  if (user && user.subscription?.plan === 'plan3' && user.subscription?.status === 'active' && user.subscription?.endDate) {
    const current = new Date(user.subscription.endDate);
    if (current > new Date()) endDate = current;
  }
  endDate.setDate(endDate.getDate() + duration);

  const subscription = {
    plan: 'plan3',
    status: 'active',
    startDate: (user?.subscription?.startDate) || new Date().toISOString(),
    endDate: endDate.toISOString(),
    paymentTxHash: `GIFTED-${Date.now()}`,
    autoRenew: false
  };
  const usage = userService.applyPlanLimits(user?.usage, 'plan3');

  if (isNewUser) {
    user = await prisma.user.create({
      data: { email: normalizedEmail, authMethod: 'gmail', subscription, usage }
    });
  } else {
    user = await prisma.user.update({ where: { id: user.id }, data: { subscription, usage } });
  }

  // Upsert a matching active Subscription history record.
  const existing = await prisma.subscription.findFirst({
    where: { userId: user.id, plan: 'plan3', status: 'active' },
    orderBy: { createdAt: 'desc' }
  });
  if (existing) {
    await prisma.subscription.update({
      where: { id: existing.id },
      data: { endDate, status: 'active' }
    });
  } else {
    await prisma.subscription.create({
      data: {
        userId: user.id,
        plan: 'plan3',
        status: 'active',
        startDate: new Date(),
        endDate,
        amount: 0,
        currency: 'XLM',
        paymentTxHash: `GIFTED-${Date.now()}`,
        autoRenew: false
      }
    });
  }

  const emailResult = await emailService.sendPremiumGiftNotification(
    normalizedEmail,
    duration,
    isNewUser,
    endDate
  );
  if (!emailResult.success) {
    console.error(`[PremiumGifts] Failed to send email to ${normalizedEmail}:`, emailResult.error);
  }

  return { user, isNewUser, emailResult };
}

/**
 * POST /api/premium-gifts/gift
 * Gift premium subscription to a user (new or existing)
 */
router.post('/gift', authenticate, async (req, res) => {
  try {
    const { email, durationDays = 30 } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, error: 'Valid email address is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const duration = parseInt(durationDays, 10) || 30;

    const { user, isNewUser, emailResult } = await giftPremium(normalizedEmail, duration);

    return res.json({
      success: true,
      message: `Premium subscription gifted to ${isNewUser ? 'new user ' : ''}${normalizedEmail}`,
      user: {
        email: user.email,
        subscription: {
          plan: user.subscription.plan,
          status: user.subscription.status,
          startDate: user.subscription.startDate,
          endDate: user.subscription.endDate
        }
      },
      isNewUser,
      emailSent: emailResult.success,
      emailError: emailResult.error || null
    });
  } catch (error) {
    console.error('Gift premium error:', error);
    res.status(500).json({ success: false, error: 'Failed to gift premium subscription', message: error.message });
  }
});

/**
 * POST /api/premium-gifts/gift-bulk
 * Gift premium to multiple users
 */
router.post('/gift-bulk', authenticate, async (req, res) => {
  try {
    const { emails, durationDays = 30 } = req.body;

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ success: false, error: 'Array of email addresses is required' });
    }
    if (emails.length > 100) {
      return res.status(400).json({ success: false, error: 'Maximum 100 emails per request' });
    }

    const duration = parseInt(durationDays, 10) || 30;
    const results = { success: [], failed: [], skipped: [] };

    for (const email of emails) {
      if (!email || !email.includes('@')) {
        results.failed.push({ email, error: 'Invalid email address' });
        continue;
      }
      const normalizedEmail = email.toLowerCase().trim();
      try {
        const { isNewUser, emailResult } = await giftPremium(normalizedEmail, duration);
        results.success.push({ email: normalizedEmail, isNewUser, emailSent: emailResult.success });
      } catch (error) {
        results.failed.push({ email: normalizedEmail, error: error.message });
      }
      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    res.json({
      success: true,
      message: `Processed ${emails.length} emails`,
      results: {
        success: results.success.length,
        failed: results.failed.length,
        skipped: results.skipped.length
      },
      details: results
    });
  } catch (error) {
    console.error('Bulk gift premium error:', error);
    res.status(500).json({ success: false, error: 'Failed to gift premium subscriptions', message: error.message });
  }
});

/**
 * GET /api/premium-gifts/list
 * Get list of all premium gifts (users with plan3)
 */
router.get('/list', authenticate, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const skip = parseInt(req.query.skip) || 0;

    // subscription is a JSON column — filter on the nested plan path.
    const where = { subscription: { path: ['plan'], equals: 'plan3' } };

    const users = await prisma.user.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip,
      select: { email: true, name: true, picture: true, subscription: true, createdAt: true }
    });

    const total = await prisma.user.count({ where });

    res.json({
      success: true,
      users: users.map((user) => ({
        email: user.email,
        name: user.name,
        picture: user.picture,
        subscription: {
          plan: user.subscription?.plan,
          status: user.subscription?.status,
          startDate: user.subscription?.startDate,
          endDate: user.subscription?.endDate
        },
        createdAt: user.createdAt
      })),
      total,
      limit,
      skip
    });
  } catch (error) {
    console.error('List premium gifts error:', error);
    res.status(500).json({ success: false, error: 'Failed to list premium gifts', message: error.message });
  }
});

module.exports = router;
