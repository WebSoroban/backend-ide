const express = require('express');
const router = express.Router();
const User = require('../models/User');
const UsageLog = require('../models/UsageLog');
const { authenticate } = require('../middleware/auth');

/**
 * GET /api/usage
 * Get current user's usage statistics
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const user = req.user;
    
    // Get usage logs for last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const logs = await UsageLog.find({
      userId: user._id,
      createdAt: { $gte: thirtyDaysAgo }
    }).sort({ createdAt: -1 }).limit(100);
    
    // Calculate statistics
    const stats = {
      deployments: {
        total: logs.filter(l => l.action === 'deploy').length,
        successful: logs.filter(l => l.action === 'deploy' && l.success).length,
        failed: logs.filter(l => l.action === 'deploy' && !l.success).length
      },
      compilations: {
        total: logs.filter(l => l.action === 'compile').length,
        successful: logs.filter(l => l.action === 'compile' && l.success).length,
        failed: logs.filter(l => l.action === 'compile' && !l.success).length
      },
      functionTests: {
        total: logs.filter(l => l.action === 'function_test').length,
        successful: logs.filter(l => l.action === 'function_test' && l.success).length,
        failed: logs.filter(l => l.action === 'function_test' && !l.success).length
      }
    };
    
    res.json({
      success: true,
      usage: {
        deployments: {
          count: user.usage.deployments.count,
          limit: user.usage.deployments.limit,
          remaining: user.usage.deployments.limit === -1 
            ? 'unlimited' 
            : Math.max(0, user.usage.deployments.limit - user.usage.deployments.count),
          lastResetDate: user.usage.deployments.lastResetDate
        },
        functionTests: {
          count: user.usage.functionTests.count,
          limit: user.usage.functionTests.limit,
          remaining: user.usage.functionTests.limit === -1 
            ? 'unlimited' 
            : Math.max(0, user.usage.functionTests.limit - user.usage.functionTests.count),
          lastResetDate: user.usage.functionTests.lastResetDate
        }
      },
      statistics: stats,
      logs: logs.slice(0, 20) // Return last 20 logs
    });
  } catch (error) {
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
router.get('/summary', async (req, res) => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Fetch recent logs for all users
    const logs = await UsageLog.find({
      createdAt: { $gte: thirtyDaysAgo }
    }).sort({ createdAt: -1 }).limit(2000);

    const totals = {
      compile: 0,
      deploy: 0,
      function_test: 0
    };

    const dailyMap = new Map();
    const uniqueUsers = new Set();

    for (const log of logs) {
      if (!log || !log.action || !log.createdAt) continue;

      const action = log.action;
      if (totals[action] !== undefined) {
        totals[action] += 1;
      }

      if (log.userId) {
        uniqueUsers.add(String(log.userId));
      }

      const dateKey = log.createdAt.toISOString().slice(0, 10);
      if (!dailyMap.has(dateKey)) {
        dailyMap.set(dateKey, {
          date: dateKey,
          compile: 0,
          deploy: 0,
          function_test: 0
        });
      }

      const day = dailyMap.get(dateKey);
      if (day[action] !== undefined) {
        day[action] += 1;
      }
    }

    const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      success: true,
      summary: {
        totalEvents: logs.length,
        uniqueUsers: uniqueUsers.size,
        totals,
        periodStart: thirtyDaysAgo.toISOString(),
        periodEnd: new Date().toISOString()
      },
      daily
    });
  } catch (error) {
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
router.get('/activity', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const logs = await UsageLog.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('userId', 'email name')
      .lean();

    const activity = logs.map((log) => ({
      _id: log._id,
      action: log.action,
      projectId: log.projectId,
      contractAddress: log.contractAddress,
      functionName: log.functionName,
      success: log.success,
      error: log.error,
      createdAt: log.createdAt,
      user: log.userId
            ? { email: log.userId.email, name: log.userId.name || null }
            : null
    }));

    res.json({ success: true, logs: activity });
  } catch (error) {
    console.error('Get usage activity error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get activity logs',
      message: error.message
    });
  }
});

module.exports = router;
