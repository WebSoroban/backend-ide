import express, { type Request, type Response } from 'express';
import prisma from '../lib/prisma';
import { authenticate, optionalAuth } from '../middleware/auth';
import invokeService, { getSpecForContract, prepareInvoke, submitInvoke } from '../services/invokeService';
import userService from '../services/userService';
import walletService from '../services/wallet';
import { coerceNetwork, getNetwork } from '../lib/networks';

const router = express.Router();

/**
 * GET /api/contracts/:contractId/spec
 * Returns the parsed function list for the type-aware invoke form.
 */
router.get('/:contractId/spec', optionalAuth, async (req: Request, res: Response) => {
  try {
    const { contractId } = req.params;
    const spec = await getSpecForContract(contractId);
    if (!spec) {
      return res.status(404).json({
        success: false,
        error: 'Contract spec not found. Recompile the contract to extract its interface.',
      });
    }
    res.json({ success: true, contractId, functions: spec.functions });
  } catch (error: any) {
    console.error('[Contracts] Spec error:', error);
    res.status(500).json({ success: false, error: 'Failed to load contract spec', message: error.message });
  }
});

/**
 * POST /api/contracts/:contractId/invoke
 * Body: { functionName, args (object keyed by param name), execute?, clientRef? }
 * Always simulates first; submits a signed tx only for state-changing calls when
 * execute === true.
 */
router.post('/:contractId/invoke', authenticate, async (req: Request, res: Response) => {
  try {
    const { contractId } = req.params;
    const { functionName, args = {}, execute = false, clientRef = null, sourcePk = null } = req.body;
    const network = coerceNetwork(req.body.network);
    if (!functionName) {
      return res.status(400).json({ success: false, error: 'Missing required parameter: functionName' });
    }
    const safeArgs = typeof args === 'object' && !Array.isArray(args) ? args : {};

    // Best-effort: associate with the user's project that owns this contract.
    const project = await prisma.project.findFirst({
      where: { contractAddress: contractId, userId: req.userId! },
      select: { id: true },
    });

    // Decide the signing path for a state-changing call:
    //   mainnet + "connected" → return the unsigned XDR for the browser wallet.
    //   testnet, or mainnet + "custodial" → backend signs in-memory.
    if (execute && network === 'mainnet') {
      const mode = await walletService.getMainnetSigningMode(req.userId!);
      if (mode === 'connected') {
        if (!sourcePk) {
          return res.status(400).json({ success: false, error: 'Connect a wallet to sign mainnet transactions.', code: 'WALLET_REQUIRED' });
        }
        const prep = await prepareInvoke({
          contractId, functionName, args: safeArgs, sourcePk, network,
          userId: req.userId!, projectId: project?.id ?? null,
        });
        if (prep.readOnly) {
          return res.json({ success: true, readOnly: true, status: 'simulated', result: prep.result, returnValue: prep.result, resourceFee: prep.resourceFee, network });
        }
        return res.json({
          success: true, needsSignature: true, readOnly: false, status: 'simulated',
          xdr: prep.xdr, feeXlm: prep.feeXlm, feeStroops: prep.feeStroops, resourceFee: prep.resourceFee,
          passphrase: getNetwork(network).passphrase, network, result: prep.result,
        });
      }
    }

    const result = await invokeService.invoke({
      contractId,
      functionName,
      args: safeArgs,
      userId: req.userId!,
      projectId: project?.id ?? null,
      network,
      execute: Boolean(execute),
      clientRef,
    });

    res.json({ ...result, network });
  } catch (error: any) {
    console.error('[Contracts] Invoke error:', error);
    res.status(400).json({ success: false, error: error.message || 'Contract invocation failed' });
  }
});

/**
 * POST /api/contracts/:contractId/invoke/submit
 * Submit a wallet-signed XDR for a non-custodial (mainnet) write. Body:
 * { functionName, args, signedXdr, network, clientRef? }.
 */
router.post('/:contractId/invoke/submit', authenticate, async (req: Request, res: Response) => {
  try {
    const { contractId } = req.params;
    const { functionName, args = {}, signedXdr, clientRef = null } = req.body;
    const network = coerceNetwork(req.body.network);
    if (!functionName || !signedXdr) {
      return res.status(400).json({ success: false, error: 'functionName and signedXdr are required' });
    }
    const project = await prisma.project.findFirst({
      where: { contractAddress: contractId, userId: req.userId! },
      select: { id: true },
    });
    const result = await submitInvoke({
      contractId, functionName, args: typeof args === 'object' && !Array.isArray(args) ? args : {},
      signedXdr, network, userId: req.userId!, projectId: project?.id ?? null, clientRef,
    });
    res.json({ ...result, network });
  } catch (error: any) {
    console.error('[Contracts] Invoke submit error:', error);
    res.status(400).json({ success: false, error: error.message || 'Submit failed' });
  }
});

/**
 * GET /api/contracts/:contractId/tests
 * List the requesting user's saved function-test cases for this contract.
 */
router.get('/:contractId/tests', authenticate, async (req: Request, res: Response) => {
  try {
    const tests = await prisma.functionTest.findMany({
      where: { contractId: req.params.contractId, userId: req.userId! },
      orderBy: { createdAt: 'asc' },
    });
    res.json({ success: true, tests });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to load tests', message: error.message });
  }
});

/**
 * POST /api/contracts/:contractId/tests
 * Save a named invocation case. Body: { functionName, name, args, expected }.
 */
router.post('/:contractId/tests', authenticate, async (req: Request, res: Response) => {
  try {
    const { functionName, name, args = {}, expected = null } = req.body;
    if (!functionName || !name) {
      return res.status(400).json({ success: false, error: 'functionName and name are required' });
    }
    const test = await prisma.functionTest.create({
      data: {
        contractId: req.params.contractId,
        userId: req.userId!,
        functionName,
        name,
        args: args as any,
        expected: expected as any,
      },
    });
    res.status(201).json({ success: true, test });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to save test', message: error.message });
  }
});

/**
 * DELETE /api/contracts/:contractId/tests/:testId
 */
router.delete('/:contractId/tests/:testId', authenticate, async (req: Request, res: Response) => {
  try {
    const test = await prisma.functionTest.findUnique({ where: { id: req.params.testId } });
    if (!test || test.userId !== req.userId) {
      return res.status(404).json({ success: false, error: 'Test not found' });
    }
    await prisma.functionTest.delete({ where: { id: req.params.testId } });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to delete test', message: error.message });
  }
});

/**
 * POST /api/contracts/:contractId/tests/run
 * Execute each saved case via the simulate path and assert the expected return.
 * Returns per-case pass/fail with actual vs expected, plus an aggregate count.
 */
router.post('/:contractId/tests/run', authenticate, async (req: Request, res: Response) => {
  try {
    const { contractId } = req.params;
    const { functionName } = req.body || {};
    const tests = await prisma.functionTest.findMany({
      where: {
        contractId,
        userId: req.userId!,
        ...(functionName ? { functionName } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });

    // Enforce the plan's function-test quota before running (only when there is
    // something to run, so an empty list never burns quota).
    if (tests.length > 0) {
      const user = await prisma.user.findUnique({ where: { id: req.userId! } });
      const gate = await userService.canTestFunction(user);
      if (!gate.allowed) {
        return res.status(403).json({
          success: false,
          error: gate.reason,
          current: gate.current,
          limit: gate.limit,
          upgradeRequired: true,
        });
      }
    }

    const results = [];
    for (const test of tests) {
      let outcome: any;
      try {
        outcome = await invokeService.invoke({
          contractId,
          functionName: test.functionName,
          args: (test.args as any) || {},
          userId: req.userId!,
          execute: false, // tests run via simulation
        });
      } catch (err: any) {
        outcome = { success: false, error: err.message };
      }

      const expected = test.expected as any;
      const { pass, reason } = assertExpected(outcome, expected);
      results.push({
        testId: test.id,
        name: test.name,
        functionName: test.functionName,
        status: pass ? 'pass' : 'fail',
        actual: outcome.returnValue ?? outcome.result ?? null,
        expected: expected ?? { mode: 'success' },
        error: outcome.error || (pass ? null : reason),
      });
    }

    const passed = results.filter((r) => r.status === 'pass').length;

    // Track the run for /analytics and the plan's usage meter. One run = one
    // unit (mirrors how a deploy is counted); per-case detail lives in metadata.
    if (results.length > 0) {
      const project = await prisma.project.findFirst({
        where: { contractAddress: contractId, userId: req.userId! },
        select: { id: true },
      });
      await prisma.usageLog.create({
        data: {
          userId: req.userId!,
          action: 'function_test',
          projectId: project?.id ?? null,
          contractAddress: contractId,
          functionName: functionName ?? null,
          success: passed === results.length,
          metadata: { total: results.length, passed, failed: results.length - passed },
        },
      }).catch((err) => console.warn('[Contracts] usageLog (function_test) failed:', err.message));
      await userService.incrementFunctionTest(req.userId!)
        .catch((err) => console.warn('[Contracts] incrementFunctionTest failed:', err.message));
    }

    res.json({ success: true, total: results.length, passed, results });
  } catch (error: any) {
    res.status(500).json({ success: false, error: 'Failed to run tests', message: error.message });
  }
});

/** Compare an invoke outcome against a saved expectation. */
function assertExpected(outcome: any, expected: any): { pass: boolean; reason: string } {
  if (!outcome?.success) return { pass: false, reason: outcome?.error || 'Invocation failed' };
  const mode = expected?.mode || 'success';
  if (mode === 'success') return { pass: true, reason: '' };

  const actual = outcome.returnValue ?? outcome.result ?? null;
  if (mode === 'equals') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected?.value);
    return { pass: a === b, reason: a === b ? '' : `Expected ${b}, got ${a}` };
  }
  if (mode === 'contains') {
    const hay = JSON.stringify(actual ?? '');
    const needle = String(expected?.value ?? '');
    const ok = hay.includes(needle);
    return { pass: ok, reason: ok ? '' : `Expected result to contain "${needle}"` };
  }
  return { pass: true, reason: '' };
}

export default router;
