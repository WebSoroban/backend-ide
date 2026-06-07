/**
 * User domain logic — replaces the instance methods that used to live on the
 * Mongoose User model (canDeploy, incrementDeployment, updateSubscription, ...).
 *
 * `subscription` and `usage` are stored as JSON columns on the User row, so
 * these helpers read/merge those objects and persist via prisma.user.update.
 */
import type { User } from '@prisma/client';
import prisma from '../lib/prisma';

interface PlanLimit {
  deployments: number;
  functionTests: number;
}

const PLAN_LIMITS: Record<string, PlanLimit> = {
  free: { deployments: 5, functionTests: 2 },
  plan2: { deployments: -1, functionTests: 5 },
  plan3: { deployments: -1, functionTests: -1 }
};

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/** Build the default `usage` JSON for a plan. */
function defaultUsage(plan = 'free'): any {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  const now = new Date().toISOString();
  return {
    deployments: { count: 0, limit: limits.deployments, lastResetDate: now },
    functionTests: { count: 0, limit: limits.functionTests, lastResetDate: now }
  };
}

/** Build the default `subscription` JSON. */
function defaultSubscription(plan = 'free'): any {
  return {
    plan,
    status: 'active',
    startDate: new Date().toISOString(),
    endDate: null,
    paymentTxHash: null,
    autoRenew: false
  };
}

/** Normalize a possibly-partial usage object to the full shape. */
function normalizeUsage(usage: any, plan = 'free'): any {
  const base = defaultUsage(plan);
  if (!usage || typeof usage !== 'object') return base;
  return {
    deployments: { ...base.deployments, ...(usage.deployments || {}) },
    functionTests: { ...base.functionTests, ...(usage.functionTests || {}) }
  };
}

/** Apply plan limits to an existing usage object (preserving counts). */
function applyPlanLimits(usage: any, plan: string): any {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  const u = normalizeUsage(usage, plan);
  u.deployments.limit = limits.deployments;
  u.functionTests.limit = limits.functionTests;
  return u;
}

/**
 * Internal: if 30 days have elapsed since lastResetDate, reset both counters.
 * Mutates and persists. Returns the (possibly updated) usage object.
 */
async function maybeResetUsage(user: any): Promise<any> {
  const usage = normalizeUsage(user.usage, user.subscription?.plan);
  const now = Date.now();
  const resetAt = new Date(usage.deployments.lastResetDate || 0).getTime();
  if (now - resetAt >= MONTH_MS) {
    const iso = new Date().toISOString();
    usage.deployments.count = 0;
    usage.deployments.lastResetDate = iso;
    usage.functionTests.count = 0;
    usage.functionTests.lastResetDate = iso;
    await prisma.user.update({ where: { id: user.id }, data: { usage } });
    user.usage = usage;
  }
  return usage;
}

/** Check whether the user may deploy (handles monthly reset). */
async function canDeploy(user: any): Promise<{ allowed: boolean; reason?: string; current?: number; limit?: number }> {
  const usage = await maybeResetUsage(user);
  const { count, limit } = usage.deployments;
  if (limit === -1) return { allowed: true };
  if (count >= limit) {
    return { allowed: false, reason: 'Deployment limit reached', current: count, limit };
  }
  return { allowed: true, current: count, limit };
}

/** Check whether the user may run a function test (handles monthly reset). */
async function canTestFunction(user: any): Promise<{ allowed: boolean; reason?: string; current?: number; limit?: number }> {
  const usage = await maybeResetUsage(user);
  const { count, limit } = usage.functionTests;
  if (limit === -1) return { allowed: true };
  if (count >= limit) {
    return { allowed: false, reason: 'Function test limit reached', current: count, limit };
  }
  return { allowed: true, current: count, limit };
}

/** Increment the deployment counter. */
async function incrementDeployment(userId: string): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  const usage = normalizeUsage(user.usage, (user.subscription as any)?.plan);
  usage.deployments.count += 1;
  return prisma.user.update({ where: { id: userId }, data: { usage } });
}

/** Increment the function-test counter. */
async function incrementFunctionTest(userId: string): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  const usage = normalizeUsage(user.usage, (user.subscription as any)?.plan);
  usage.functionTests.count += 1;
  return prisma.user.update({ where: { id: userId }, data: { usage } });
}

/**
 * Update the denormalized subscription JSON on the user and adjust usage limits.
 * Returns the updated user row.
 */
async function updateSubscription(userId: string, plan: string, paymentTxHash: string | null = null): Promise<User | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const subscription: any = {
    ...defaultSubscription(plan),
    ...((user.subscription as any) || {}),
    plan,
    status: 'active',
    startDate: new Date().toISOString()
  };
  if (plan !== 'free') {
    subscription.endDate = new Date(Date.now() + MONTH_MS).toISOString();
  } else {
    subscription.endDate = null;
  }
  if (paymentTxHash) subscription.paymentTxHash = paymentTxHash;

  const usage = applyPlanLimits(user.usage, plan);

  return prisma.user.update({ where: { id: userId }, data: { subscription, usage } });
}

export {
  PLAN_LIMITS,
  defaultUsage,
  defaultSubscription,
  normalizeUsage,
  applyPlanLimits,
  canDeploy,
  canTestFunction,
  incrementDeployment,
  incrementFunctionTest,
  updateSubscription
};

export default {
  PLAN_LIMITS,
  defaultUsage,
  defaultSubscription,
  normalizeUsage,
  applyPlanLimits,
  canDeploy,
  canTestFunction,
  incrementDeployment,
  incrementFunctionTest,
  updateSubscription
};
