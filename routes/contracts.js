const express = require('express');
const router = express.Router();
const deploymentService = require('../services/deploymentService');
const { authenticate } = require('../middleware/auth');

/**
 * POST /api/contracts/:contractAddress/invoke
 * Invoke a contract function (IDE). Requires JWT.
 */
router.post('/:contractAddress/invoke', authenticate, async (req, res) => {
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
  } catch (error) {
    console.error('[Contracts] Invoke error:', error);
    res.status(500).json({
      success: false,
      error: 'Contract invocation failed',
      message: error.message
    });
  }
});

module.exports = router;
