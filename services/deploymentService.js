const { exec, execSync, spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const util = require('util');
const execAsync = util.promisify(exec);
const socketService = require('./socketService');
const walletService = require('./wallet');
const StellarSdk = require('@stellar/stellar-sdk');

// TESTNET ONLY — hardcoded. There is intentionally no mainnet code path.
const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const TESTNET_PASSPHRASE = StellarSdk.Networks.TESTNET;

/**
 * Environment for the Stellar CLI. The signing secret is passed via the
 * STELLAR_ACCOUNT env var (read by `--source-account`) so it never appears on
 * the command line / process list / logs. Always testnet.
 */
function getStellarEnv(secret = null) {
  const env = {
    ...process.env,
    STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
    STELLAR_RPC_URL: process.env.SOROBAN_RPC_URL || TESTNET_RPC
  };
  if (secret) {
    // Used as the source account / signing key by `stellar contract deploy`.
    env.STELLAR_ACCOUNT = secret;
  }
  return env;
}

// Check if Stellar CLI is available
let stellarAvailable = false;
try {
  execSync('stellar --version', { stdio: 'ignore' });
  stellarAvailable = true;
} catch (error) {
  console.warn('Stellar CLI not available');
}

class DeploymentService {
  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'soroban-deploy');
  }

  /**
   * Validate WASM file format and content
   */
  validateWasmFile(wasmBuffer) {
    const errors = [];

    if (wasmBuffer.length < 8) {
      errors.push('WASM file too small (minimum 8 bytes)');
      return { valid: false, errors };
    }

    const magic = wasmBuffer.slice(0, 4).toString('hex');
    if (magic !== '0061736d') {
      errors.push(`Invalid WASM magic bytes: ${magic} (expected: 0061736d)`);
    }

    const version = wasmBuffer.slice(4, 8).toString('hex');
    if (version !== '01000000') {
      errors.push(`Unsupported WASM version: ${version} (expected: 01000000)`);
    }

    if (wasmBuffer.length >= 12) {
      let hasSection = false;
      for (let i = 8; i < Math.min(wasmBuffer.length, 100); i++) {
        if (wasmBuffer[i] >= 0 && wasmBuffer[i] <= 11) {
          hasSection = true;
          break;
        }
      }
      if (!hasSection) {
        errors.push('No valid WASM sections found');
      }
    }

    return { valid: errors.length === 0, errors, magic, version, size: wasmBuffer.length };
  }

  /**
   * Deploy a smart contract to Stellar TESTNET, signed with the requesting
   * user's own wallet. The secret is loaded in-memory via the wallet service
   * and handed to the CLI through STELLAR_ACCOUNT — never logged or put on argv.
   *
   * @param {string} projectId
   * @param {string} wasmBase64
   * @param {string} _network  ignored — always testnet
   * @param {string} userId    the deploying user (whose wallet signs)
   * @param {Function} onLogUpdate
   * @param {string} jobId
   */
  async deployContract(projectId, wasmBase64, _network = 'testnet', userId = null, onLogUpdate = null, jobId = null) {
    const logs = [];

    const log = (type, message) => {
      const logEntry = { type, message, timestamp: new Date().toISOString() };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
      if (jobId) socketService.emitLog(jobId, logEntry);
      if (onLogUpdate && typeof onLogUpdate === 'function') {
        onLogUpdate([...logs]).catch((err) => console.error('Error updating deployment job logs:', err));
      }
    };

    try {
      if (!userId) {
        throw new Error('A userId is required to deploy (deploys are signed with the user wallet)');
      }
      if (!stellarAvailable) {
        log('error', 'Stellar CLI not available. Please install it first.');
        throw new Error('Stellar CLI not installed');
      }

      log('info', 'Starting deployment to testnet...');

      // Ensure the user has a funded testnet wallet, then load its keypair.
      await walletService.getOrCreateWallet(userId);
      const keypair = await walletService.loadKeypair(userId);
      const publicKey = keypair.publicKey();
      const secret = keypair.secret(); // in-memory only; never logged
      log('info', `Deploying with user wallet: ${publicKey}`);

      // Create project directory
      const projectDir = path.join(this.tempDir, projectId);
      await fs.remove(projectDir);
      await fs.ensureDir(projectDir);

      // Write + validate WASM file
      const wasmBuffer = Buffer.from(wasmBase64, 'base64');
      const wasmPath = path.join(projectDir, 'contract.wasm');
      await fs.writeFile(wasmPath, wasmBuffer);
      log('info', `WASM file written: ${wasmBuffer.length} bytes`);

      const validation = this.validateWasmFile(wasmBuffer);
      if (!validation.valid) {
        log('error', `WASM validation failed: ${validation.errors.join(', ')}`);
        throw new Error(`Invalid WASM file: ${validation.errors.join(', ')}`);
      }
      log('info', `WASM validation passed: size=${validation.size} bytes`);

      // Deploy. The secret is provided via STELLAR_ACCOUNT in the env only.
      log('info', 'Deploying contract...');
      const deployEnv = getStellarEnv(secret);
      const deployProcess = spawn('stellar', [
        'contract', 'deploy',
        '--wasm', wasmPath,
        '--network', 'testnet',
        '--alias', projectId
      ], { stdio: ['pipe', 'pipe', 'pipe'], env: deployEnv });

      let deployOutput = '';

      deployProcess.stdout.on('data', (data) => {
        const output = data.toString();
        deployOutput += output;
        output.split('\n').forEach((line) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          const lower = trimmed.toLowerCase();
          if (lower.includes('error') || lower.includes('failed')) log('error', trimmed);
          else if (lower.includes('warning')) log('warning', trimmed);
          else if (lower.includes('success') || lower.includes('deployed') || lower.includes('contract')) log('success', trimmed);
          else log('info', trimmed);
        });
      });

      deployProcess.stderr.on('data', (data) => {
        const error = data.toString();
        error.split('\n').forEach((line) => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.includes('Build Complete')) {
            const lower = trimmed.toLowerCase();
            if (lower.includes('error') || lower.includes('failed')) log('error', trimmed);
            else log('warning', trimmed);
          }
        });
      });

      await new Promise((resolve, reject) => {
        deployProcess.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Deployment process exited with code ${code}`));
        });
      });

      const contractId = this.extractContractId(deployOutput);
      if (!contractId) {
        log('error', 'Failed to extract contract ID from deployment output');
        throw new Error('Failed to extract contract ID from deployment output');
      }

      log('success', `Contract deployed successfully with ID: ${contractId}`);

      return {
        success: true,
        logs,
        contractAddress: contractId,
        network: 'testnet',
        projectId,
        walletAddress: publicKey
      };
    } catch (error) {
      log('error', `Deployment failed: ${error.message}`);
      return { success: false, logs, error: error.message };
    } finally {
      try {
        const projectDir = path.join(this.tempDir, projectId);
        await fs.remove(projectDir);
      } catch (e) {
        console.error('Cleanup error:', e);
      }
    }
  }

  /**
   * Invoke a contract function on TESTNET via Soroban RPC simulation
   * (read-only — used for function testing in the IDE). Uses an ephemeral
   * random source account; no signing key is required for simulation.
   */
  async invokeContract(contractId, functionName, args = [], _sourceAccount = null, _network = 'testnet') {
    const logs = [];

    const log = (type, message) => {
      const logEntry = { type, message, timestamp: new Date().toISOString() };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
    };

    try {
      log('info', `Invoking contract function: ${functionName}`);
      log('info', `Contract ID: ${contractId}`);

      const SorobanRpc = StellarSdk.SorobanRpc || StellarSdk.rpc;
      if (!SorobanRpc) {
        throw new Error('Soroban RPC not available in SDK');
      }

      const server = new SorobanRpc.Server(TESTNET_RPC);
      log('info', `Using Soroban RPC: ${TESTNET_RPC}`);

      // Ephemeral keypair for read-only simulation.
      const keypair = StellarSdk.Keypair.random();
      const sourceAccountAddress = keypair.publicKey();

      let account;
      try {
        account = await server.getAccount(sourceAccountAddress);
      } catch (accountError) {
        // Account won't exist (random) — use a zero-sequence account for simulation.
        account = new StellarSdk.Account(sourceAccountAddress, '0');
      }

      const contract = new StellarSdk.Contract(contractId);

      const scValArgs = args.map((arg) => {
        try {
          if (typeof arg === 'string' && !isNaN(arg) && !isNaN(parseFloat(arg))) {
            return StellarSdk.nativeToScVal(parseInt(arg), { type: 'i128' });
          }
          if (typeof arg === 'string') {
            return StellarSdk.nativeToScVal(arg, { type: 'symbol' });
          }
          return StellarSdk.nativeToScVal(arg);
        } catch (e) {
          log('warning', `Could not convert arg ${arg}: ${e.message}, using as string`);
          return StellarSdk.nativeToScVal(String(arg), { type: 'string' });
        }
      });

      const transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: TESTNET_PASSPHRASE
      })
        .addOperation(contract.call(functionName, ...scValArgs))
        .setTimeout(30)
        .build();

      log('info', 'Simulating transaction...');
      const simulateResponse = await server.simulateTransaction(transaction);

      if (simulateResponse.errorResult) {
        const errorStr = JSON.stringify(simulateResponse.errorResult);
        log('error', `Simulation failed: ${errorStr}`);
        throw new Error(`Simulation failed: ${errorStr}`);
      }

      let output = null;
      if (simulateResponse.result && simulateResponse.result.retval) {
        try {
          const retval = simulateResponse.result.retval;
          let scVal;
          try {
            scVal = StellarSdk.xdr.ScVal.fromXDR(retval, 'base64');
          } catch (xdrError) {
            scVal = retval;
          }

          if (scVal && typeof scVal.switch === 'function') {
            const scValType = scVal.switch();
            if (scValType === StellarSdk.xdr.ScValType.scvSymbol()) {
              output = scVal.sym().toString();
            } else if (scValType === StellarSdk.xdr.ScValType.scvString()) {
              output = scVal.str().toString();
            } else if (scValType === StellarSdk.xdr.ScValType.scvI128()) {
              const i128 = scVal.i128();
              if (i128 && i128.hi && i128.lo !== undefined) {
                const high = BigInt(i128.hi.toString());
                const low = BigInt(i128.lo.toString());
                const result = (high << 64n) + (low < 0n ? low + (1n << 64n) : low);
                output = result.toString();
              } else {
                output = scVal.i128().toString();
              }
            } else if (scValType === StellarSdk.xdr.ScValType.scvI32()) {
              output = scVal.i32().toString();
            } else if (scValType === StellarSdk.xdr.ScValType.scvU32()) {
              output = scVal.u32().toString();
            } else if (scValType === StellarSdk.xdr.ScValType.scvBool()) {
              output = scVal.b().toString();
            } else {
              try {
                output = JSON.stringify(scVal);
              } catch (e) {
                output = scVal.toString();
              }
            }
          } else if (scVal) {
            output = typeof scVal === 'string' ? scVal : JSON.stringify(scVal);
          }
        } catch (decodeError) {
          log('warning', `Could not decode result: ${decodeError.message}`);
          output = 'Unable to decode result (check logs for details)';
        }
      }

      if (output === null) {
        output = 'Function executed successfully (no return value)';
      }

      log('success', 'Contract function invoked successfully');
      log('info', `Output: ${output}`);

      return { success: true, logs, output, contractId, functionName, args };
    } catch (error) {
      log('error', `Contract invocation failed: ${error.message}`);
      return { success: false, logs, error: error.message };
    }
  }

  /**
   * Get network information (testnet)
   */
  async getNetworkInfo() {
    try {
      if (!stellarAvailable) {
        return { success: false, error: 'Stellar CLI not installed' };
      }
      const { stdout } = await execAsync('stellar network ls');
      return { success: true, network: 'testnet', info: stdout };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Extract contract ID from CLI output
   */
  extractContractId(output) {
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.trim().startsWith('C') && line.trim().length > 50) {
        return line.trim();
      }
      if (line.includes('Contract ID:')) {
        const contractId = line.split('Contract ID:')[1].trim();
        if (contractId && contractId.startsWith('C')) return contractId;
      }
      if (line.includes('id:') && line.includes('C')) {
        const match = line.match(/id:\s*(C[A-Z0-9]+)/);
        if (match && match[1]) return match[1];
      }
      if (line.includes('"id"') && line.includes('C')) {
        const match = line.match(/"id":\s*"(C[A-Z0-9]+)"/);
        if (match && match[1]) return match[1];
      }
    }
    return null;
  }
}

module.exports = new DeploymentService();
