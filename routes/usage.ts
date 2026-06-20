import express, { type Request, type Response } from 'express';
import prisma from '../lib/prisma';
import userService from '../services/userService';
import { withId } from '../lib/serialize';
import { authenticate } from '../middleware/auth';
import { requireAdmin } from '../middleware/admin';

const router = express.Router();

/**
 * GET /api/usage
 * Get current user's usage statistics
 */
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const usage = userService.normalizeUsage(user.usage, (user.subscription as any)?.plan);

    // Get usage logs for last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const logs = await prisma.usageLog.findMany({
      where: { userId: user.id, createdAt: { gte: thirtyDaysAgo } },
      orderBy: { createdAt: 'desc' },
      take: 100
    });

    // Calculate statistics
    const stats = {
      deployments: {
        total: logs.filter((l) => l.action === 'deploy').length,
        successful: logs.filter((l) => l.action === 'deploy' && l.success).length,
        failed: logs.filter((l) => l.action === 'deploy' && !l.success).length
      },
      compilations: {
        total: logs.filter((l) => l.action === 'compile').length,
        successful: logs.filter((l) => l.action === 'compile' && l.success).length,
        failed: logs.filter((l) => l.action === 'compile' && !l.success).length
      },
      functionTests: {
        total: logs.filter((l) => l.action === 'function_test').length,
        successful: logs.filter((l) => l.action === 'function_test' && l.success).length,
        failed: logs.filter((l) => l.action === 'function_test' && !l.success).length
      },
      invocations: {
        total: logs.filter((l) => l.action === 'invoke').length,
        successful: logs.filter((l) => l.action === 'invoke' && l.success).length,
        failed: logs.filter((l) => l.action === 'invoke' && !l.success).length
      }
    };

    res.json({
      success: true,
      usage: {
        deployments: {
          count: usage.deployments.count,
          limit: usage.deployments.limit,
          remaining: usage.deployments.limit === -1
            ? 'unlimited'
            : Math.max(0, usage.deployments.limit - usage.deployments.count),
          lastResetDate: usage.deployments.lastResetDate
        },
        functionTests: {
          count: usage.functionTests.count,
          limit: usage.functionTests.limit,
          remaining: usage.functionTests.limit === -1
            ? 'unlimited'
            : Math.max(0, usage.functionTests.limit - usage.functionTests.count),
          lastResetDate: usage.functionTests.lastResetDate
        }
      },
      statistics: stats,
      logs: logs.slice(0, 20).map(withId)
    });
  } catch (error: any) {
    console.error('Get usage error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get usage statistics',
      message: error.message
    });
  }
});

/**
 * GET /api/usage/summary
 * Get aggregate usage statistics for the whole project (all users)
 */
router.get('/summary', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const logs = await prisma.usageLog.findMany({
      where: { createdAt: { gte: thirtyDaysAgo } },
      orderBy: { createdAt: 'desc' },
      take: 2000
    });

    const totals: Record<string, number> = { compile: 0, deploy: 0, function_test: 0, invoke: 0 };
    // Deploys + invokes split by network (network lives in the log's metadata).
    const deployByNetwork: Record<string, number> = { testnet: 0, mainnet: 0 };
    const invokeByNetwork: Record<string, number> = { testnet: 0, mainnet: 0 };
    const dailyMap = new Map<string, any>();
    const uniqueUsers = new Set<string>();

    for (const log of logs) {
      if (!log || !log.action || !log.createdAt) continue;

      const action = log.action;
      if (totals[action] !== undefined) totals[action] += 1;
      const net = (log.metadata && (log.metadata as any).network) === 'mainnet' ? 'mainnet' : 'testnet';
      if (action === 'deploy') deployByNetwork[net] += 1;
      if (action === 'invoke') invokeByNetwork[net] += 1;
      if (log.userId) uniqueUsers.add(String(log.userId));

      const dateKey = log.createdAt.toISOString().slice(0, 10);
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, { date: dateKey, compile: 0, deploy: 0, function_test: 0, invoke: 0 });
      }
      const day = dailyMap.get(dateKey);
      if (day[action] !== undefined) day[action] += 1;
    }

    const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      success: true,
      summary: {
        totalEvents: logs.length,
        uniqueUsers: uniqueUsers.size,
        totals,
        deployByNetwork,
        invokeByNetwork,
        periodStart: thirtyDaysAgo.toISOString(),
        periodEnd: new Date().toISOString()
      },
      daily
    });
  } catch (error: any) {
    console.error('Get usage summary error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get usage summary',
      message: error.message
    });
  }
});

/**
 * GET /api/usage/activity
 * Get recent activity logs for all users (platform-wide for analytics)
 */
router.get('/activity', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);
    const logs = await prisma.usageLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { user: { select: { email: true, name: true } } }
    });

    const activity = logs.map((log: any) => ({
      _id: log.id,
      action: log.action,
      projectId: log.projectId,
      contractAddress: log.contractAddress,
      functionName: log.functionName,
      // Network is recorded in metadata by the deploy/invoke paths; default to
      // testnet for older rows + network-agnostic actions (compile).
      network: (log.metadata && (log.metadata as any).network) || 'testnet',
      success: log.success,
      error: log.error,
      createdAt: log.createdAt,
      user: log.user ? { email: log.user.email, name: log.user.name || null } : null
    }));

    res.json({ success: true, logs: activity });
  } catch (error: any) {
    console.error('Get usage activity error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get activity logs',
      message: error.message
    });
  }
});

/**
 * GET /api/usage/users  (admin only)
 * User directory with per-user aggregate counts, newest first. Supports
 * ?q=<email/name search> and ?limit= (default 100, max 500).
 */
router.get('/users', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);
    const q = ((req.query.q as string) || '').trim();
    const where: any = q
      ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] }
      : {};

    const [total, users] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          email: true,
          name: true,
          picture: true,
          authMethod: true,
          subscription: true,
          isActive: true,
          createdAt: true,
          lastLogin: true,
          _count: { select: { projects: true, deployments: true, invocations: true, agentRuns: true } },
        },
      }),
    ]);

    const rows = users.map((u: any) => ({
      id: u.id,
      email: u.email,
      name: u.name || null,
      picture: u.picture || null,
      authMethod: u.authMethod,
      plan: (u.subscription && (u.subscription as any).plan) || 'free',
      isActive: u.isActive,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
      projects: u._count.projects,
      deployments: u._count.deployments,
      invocations: u._count.invocations,
      aiRuns: u._count.agentRuns,
    }));

    res.json({ success: true, total, returned: rows.length, users: rows });
  } catch (error: any) {
    console.error('Get users error:', error);
    res.status(500).json({ success: false, error: 'Failed to get users', message: error.message });
  }
});

export default router;
