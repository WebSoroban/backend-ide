import { exec, execSync, spawn } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import util from 'util';
import socketService from './socketService';
import walletService from './wallet';
import * as StellarSdk from '@stellar/stellar-sdk';
import type { LogEntry } from './compilationService';

const execAsync = util.promisify(exec);

// TESTNET ONLY — hardcoded. There is intentionally no mainnet code path.
const TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const TESTNET_PASSPHRASE = StellarSdk.Networks.TESTNET;

type LogFn = (type: string, message: string) => void;
type LogUpdateCallback = (logs: LogEntry[]) => Promise<any>;

export interface DeploymentResult {
  success: boolean;
  logs: LogEntry[];
  contractAddress?: string;
  network?: string;
  projectId?: string;
  walletAddress?: string;
  error?: string;
  isMock?: boolean;
}

/**
 * Environment for the Stellar CLI. The signing secret is passed via the
 * STELLAR_ACCOUNT env var (read by `--source-account`) so it never appears on
 * the command line / process list / logs. Always testnet.
 */
function getStellarEnv(secret: string | null = null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
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

// Check if Stellar CLI is available. Bounded by a timeout so a slow/hung CLI
// can never block process startup (this runs at import time).
let stellarAvailable = false;
try {
  execSync('stellar --version', { stdio: 'ignore', timeout: 5000 });
  stellarAvailable = true;
} catch (error) {
  console.warn('Stellar CLI not available (or timed out)');
}

class DeploymentService {
  tempDir: string;

  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'soroban-deploy');
  }

  /**
   * Validate WASM file format and content
   */
  validateWasmFile(wasmBuffer: Buffer): {
    valid: boolean;
    errors: string[];
    magic?: string;
    version?: string;
    size?: number;
  } {
    const errors: string[] = [];

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
   */
  async deployContract(
    projectId: string,
    wasmBase64: string,
    _network: string = 'testnet',
    userId: string | null = null,
    onLogUpdate: LogUpdateCallback | null = null,
    jobId: string | null = null
  ): Promise<DeploymentResult> {
    const logs: LogEntry[] = [];

    const log: LogFn = (type, message) => {
      const logEntry: LogEntry = { type, message, timestamp: new Date().toISOString() };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
      if (jobId) socketService.emitLog(jobId, logEntry);
      if (onLogUpdate && typeof onLogUpdate === 'function') {
        onLogUpdate([...logs]).catch((err: any) => console.error('Error updating deployment job logs:', err));
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
      const deployProcess = spawn(
        'stellar',
        ['contract', 'deploy', '--wasm', wasmPath, '--network', 'testnet', '--alias', projectId],
        { stdio: ['pipe', 'pipe', 'pipe'], env: deployEnv }
      );

      let deployOutput = '';

      deployProcess.stdout.on('data', (data: Buffer) => {
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

      deployProcess.stderr.on('data', (data: Buffer) => {
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

      await new Promise<void>((resolve, reject) => {
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
    } catch (error: any) {
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
  async invokeContract(
    contractId: string,
    functionName: string,
    args: any[] = [],
    _sourceAccount: string | null = null,
    _network: string = 'testnet'
  ): Promise<any> {
    const logs: LogEntry[] = [];

    const log: LogFn = (type, message) => {
      const logEntry: LogEntry = { type, message, timestamp: new Date().toISOString() };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
    };

    try {
      log('info', `Invoking contract function: ${functionName}`);
      log('info', `Contract ID: ${contractId}`);

      const SorobanRpc = (StellarSdk as any).SorobanRpc || (StellarSdk as any).rpc;
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
          if (typeof arg === 'string' && !isNaN(arg as any) && !isNaN(parseFloat(arg))) {
            return StellarSdk.nativeToScVal(parseInt(arg), { type: 'i128' });
          }
          if (typeof arg === 'string') {
            return StellarSdk.nativeToScVal(arg, { type: 'symbol' });
          }
          return StellarSdk.nativeToScVal(arg);
        } catch (e: any) {
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
      const simulateResponse: any = await server.simulateTransaction(transaction);

      if (simulateResponse.errorResult) {
        const errorStr = JSON.stringify(simulateResponse.errorResult);
        log('error', `Simulation failed: ${errorStr}`);
        throw new Error(`Simulation failed: ${errorStr}`);
      }

      let output: any = null;
      if (simulateResponse.result && simulateResponse.result.retval) {
        try {
          const retval = simulateResponse.result.retval;
          let scVal: any;
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
        } catch (decodeError: any) {
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
    } catch (error: any) {
      log('error', `Contract invocation failed: ${error.message}`);
      return { success: false, logs, error: error.message };
    }
  }

  /**
   * Get network information (testnet)
   */
  async getNetworkInfo(_network?: string): Promise<any> {
    try {
      if (!stellarAvailable) {
        return { success: false, error: 'Stellar CLI not installed' };
      }
      const { stdout } = await execAsync('stellar network ls');
      return { success: true, network: 'testnet', info: stdout };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Extract contract ID from CLI output
   */
  extractContractId(output: string): string | null {
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

export default new DeploymentService();
