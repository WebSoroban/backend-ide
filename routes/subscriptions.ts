import express, { type Request, type Response } from 'express';
import prisma from '../lib/prisma';
import userService from '../services/userService';
import { authenticate } from '../middleware/auth';

const router = express.Router();

// Plan pricing (in XLM)
const PLAN_PRICES: Record<string, number> = {
  plan2: 50, // 50 XLM
  plan3: 100 // 100 XLM
};

/**
 * GET /api/subscriptions/plans
 * Get available subscription plans
 */
router.get('/plans', (req: Request, res: Response) => {
  res.json({
    success: true,
    plans: {
      free: {
        name: 'Free',
        price: 0,
        features: {
          compilations: 'unlimited',
          deployments: 5,
          functionTests: 2
        }
      },
      plan2: {
        name: 'Pro',
        price: PLAN_PRICES.plan2,
        currency: 'XLM',
        features: {
          compilations: 'unlimited',
          deployments: 'unlimited',
          functionTests: 5
        }
      },
      plan3: {
        name: 'Premium',
        price: PLAN_PRICES.plan3,
        currency: 'XLM',
        features: {
          compilations: 'unlimited',
          deployments: 'unlimited',
          functionTests: 'unlimited'
        }
      }
    }
  });
});

/**
 * GET /api/subscriptions/current
 * Get current user's subscription
 */
router.get('/current', authenticate, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const subscription: any = user.subscription || {};

    res.json({
      success: true,
      subscription: {
        plan: subscription.plan,
        status: subscription.status,
        startDate: subscription.startDate,
        endDate: subscription.endDate,
        autoRenew: subscription.autoRenew
      },
      usage: user.usage
    });
  } catch (error: any) {
    console.error('Get subscription error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get subscription',
      message: error.message
    });
  }
});

/**
 * POST /api/subscriptions/create
 * Create subscription payment request
 */
router.post('/create', authenticate, async (req: Request, res: Response) => {
  try {
    const { plan } = req.body;
    const user = req.user!;
    const subscription: any = user.subscription || {};

    if (!plan || !['plan2', 'plan3'].includes(plan)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid plan. Must be plan2 or plan3'
      });
    }

    if (subscription.plan === plan && subscription.status === 'active') {
      return res.status(400).json({
        success: false,
        error: 'You already have an active subscription for this plan'
      });
    }

    const price = PLAN_PRICES[plan];
    const paymentAddress = process.env.PAYMENT_ADDRESS || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

    // Create subscription record (30-day term)
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 30);

    const newSubscription = await prisma.subscription.create({
      data: {
        userId: user.id,
        plan,
        status: 'active',
        startDate: new Date(),
        endDate,
        amount: price,
        currency: 'XLM'
      }
    });

    // Generate payment memo (user ID for verification)
    const memo = user.id;

    res.json({
      success: true,
      subscription: {
        _id: newSubscription.id,
        plan: newSubscription.plan,
        amount: newSubscription.amount,
        currency: newSubscription.currency
      },
      payment: {
        address: paymentAddress,
        amount: price,
        currency: 'XLM',
        memo: memo,
        network: process.env.PAYMENT_NETWORK || 'testnet'
      },
      message: `Send ${price} XLM to ${paymentAddress} with memo: ${memo}`
    });
  } catch (error: any) {
    console.error('Create subscription error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create subscription',
      message: error.message
    });
  }
});

/**
 * POST /api/subscriptions/cancel
 * Cancel subscription
 */
router.post('/cancel', authenticate, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const subscription: any = user.subscription || {};

    if ((subscription?.plan || 'free') === 'free') {
      return res.status(400).json({
        success: false,
        error: 'Cannot cancel free plan'
      });
    }

    // Find active subscription
    const activeSubscription = await prisma.subscription.findFirst({
      where: { userId: user.id, status: 'active' },
      orderBy: { createdAt: 'desc' }
    });

    if (activeSubscription) {
      await prisma.subscription.update({
        where: { id: activeSubscription.id },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledReason: 'User requested cancellation'
        }
      });
    }

    // Downgrade user to free plan
    await userService.updateSubscription(user.id, 'free');

    res.json({
      success: true,
      message: 'Subscription cancelled successfully'
    });
  } catch (error: any) {
    console.error('Cancel subscription error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cancel subscription',
      message: error.message
    });
  }
});

export default router;
