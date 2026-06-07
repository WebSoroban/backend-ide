import express, { type Request, type Response } from 'express';
import deploymentService from '../services/deploymentService';
import { authenticate } from '../middleware/auth';

const router = express.Router();

/**
 * POST /api/contracts/:contractAddress/invoke
 * Invoke a contract function (IDE). Requires JWT.
 */
router.post('/:contractAddress/invoke', authenticate, async (req: Request, res: Response) => {
  try {
    const contractAddress = req.params.contractAddress;
    const { functionName, args = [], network = 'testnet' } = req.body;
    if (!functionName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: functionName'
      });
    }
    const invokeResult = await deploymentService.invokeContract(
      contractAddress,
      functionName,
      args,
      null,
      network
    );
    res.json({
      success: invokeResult.success,
      output: invokeResult.output,
      contractId: invokeResult.contractId,
      functionName: invokeResult.functionName,
      args: invokeResult.args,
      logs: invokeResult.logs
    });
  } catch (error: any) {
    console.error('[Contracts] Invoke error:', error);
    res.status(500).json({
      success: false,
      error: 'Contract invocation failed',
      message: error.message
    });
  }
});

export default router;
