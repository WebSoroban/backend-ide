const { exec, execSync, spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const util = require('util');
const execAsync = util.promisify(exec);
const socketService = require('./socketService');
const StellarSdk = require('@stellar/stellar-sdk');

const DEFAULT_TESTNET_RPC = 'https://soroban-testnet.stellar.org';
const DEFAULT_PUBLIC_RPC = 'https://soroban-mainnet.stellar.org';

/** Get env for Stellar CLI so RPC + network work (required by newer stellar-cli). */
function getStellarEnv(network = 'testnet') {
  const passphrase = network === 'testnet' || network === 'test'
    ? StellarSdk.Networks.TESTNET
    : StellarSdk.Networks.PUBLIC;
  const rpcUrl = process.env.SOROBAN_RPC_URL || process.env.STELLAR_RPC_URL ||
    (network === 'testnet' || network === 'test' ? DEFAULT_TESTNET_RPC : DEFAULT_PUBLIC_RPC);
  return {
    ...process.env,
    STELLAR_NETWORK_PASSPHRASE: passphrase,
    STELLAR_RPC_URL: rpcUrl
  };
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
    this.defaultKeypairName = 'deploy_keypair';
  }

  /**
   * Ensure the default keypair exists, create if it doesn't
   */
  async ensureDefaultKeypair(network = 'testnet') {
    try {
      // Check if keypair exists
      await execAsync(`stellar keys address ${this.defaultKeypairName}`);
      return true;
    } catch (error) {
      // Keypair doesn't exist, create it
      const env = getStellarEnv(network);
      const passphrase = network === 'testnet' || network === 'test'
        ? StellarSdk.Networks.TESTNET
        : StellarSdk.Networks.PUBLIC;
      const passphraseArg = `--network-passphrase ${JSON.stringify(passphrase)}`;
      try {
        if (network === 'testnet') {
          // For testnet, create and fund the account (passphrase + RPC URL required for --fund)
          await execAsync(
            `stellar keys generate ${this.defaultKeypairName} --network ${network} ${passphraseArg} --fund`,
            { env }
          );
          console.log(`Created and funded default keypair: ${this.defaultKeypairName}`);
        } else {
          await execAsync(
            `stellar keys generate ${this.defaultKeypairName} --network ${network} ${passphraseArg}`,
            { env }
          );
          console.log(`Created default keypair: ${this.defaultKeypairName}`);
        }
        return true;
      } catch (createError) {
        const detail = createError.stderr || createError.message || String(createError);
        console.error(`Failed to create default keypair: ${detail}`);
        throw new Error(`Keypair creation failed: ${detail}`);
      }
    }
  }

  /**
   * Check Stellar CLI configuration and network connectivity
   */
  async checkStellarConfig(network = 'testnet') {
    const logs = [];
    
    const log = (type, message) => {
      const logEntry = {
        type,
        message,
        timestamp: new Date().toISOString()
      };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
    };

    try {
      // Check if Stellar CLI is available
      if (!stellarAvailable) {
        log('error', 'Stellar CLI not available');
        return {
          success: false,
          logs,
          error: 'Stellar CLI not installed'
        };
      }

      // Check Stellar CLI version
      try {
        const { stdout: versionOutput } = await execAsync('stellar --version');
        log('info', `Stellar CLI version: ${versionOutput.trim()}`);
      } catch (error) {
        log('error', `Failed to get Stellar CLI version: ${error.message}`);
        return {
          success: false,
          logs,
          error: 'Stellar CLI version check failed'
        };
      }

      // Check network configuration
      try {
        const { stdout: networkOutput } = await execAsync('stellar network ls');
        log('info', 'Available networks:');
        log('info', networkOutput.trim());
      } catch (error) {
        log('error', `Failed to list networks: ${error.message}`);
        return {
          success: false,
          logs,
          error: 'Network configuration check failed'
        };
      }

      // Check default keypair
      try {
        const { stdout: addressOutput } = await execAsync(`stellar keys address ${this.defaultKeypairName}`);
        const address = addressOutput.trim();
        log('info', `Default keypair address: ${address}`);
      } catch (error) {
        log('warning', `Default keypair not found: ${error.message}`);
        log('info', 'Will create default keypair during deployment');
      }

      log('success', 'Stellar CLI configuration check passed');
      return {
        success: true,
        logs
      };

    } catch (error) {
      log('error', `Configuration check failed: ${error.message}`);
      return {
        success: false,
        logs,
        error: error.message
      };
    }
  }

  /**
   * Validate WASM file format and content
   */
  validateWasmFile(wasmBuffer) {
    const errors = [];
    
    // Check file size
    if (wasmBuffer.length < 8) {
      errors.push('WASM file too small (minimum 8 bytes)');
      return { valid: false, errors };
    }
    
    // Check magic bytes
    const magic = wasmBuffer.slice(0, 4).toString('hex');
    if (magic !== '0061736d') {
      errors.push(`Invalid WASM magic bytes: ${magic} (expected: 0061736d)`);
    }
    
    // Check version
    const version = wasmBuffer.slice(4, 8).toString('hex');
    if (version !== '01000000') {
      errors.push(`Unsupported WASM version: ${version} (expected: 01000000)`);
    }
    
    // Check for basic WASM structure
    if (wasmBuffer.length >= 12) {
      // Look for section headers
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
    
    return {
      valid: errors.length === 0,
      errors,
      magic,
      version,
      size: wasmBuffer.length
    };
  }

  /**
   * Deploy a smart contract to Stellar testnet
   */
  async deployContract(projectId, wasmBase64, network = 'testnet', walletInfo = null, onLogUpdate = null, jobId = null) {
    const logs = [];
    
    const log = (type, message) => {
      const logEntry = {
        type,
        message,
        timestamp: new Date().toISOString()
      };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
      
      // Emit log via WebSocket if jobId provided
      if (jobId) {
        console.log(`[DeploymentService] Emitting log for job ${jobId}:`, logEntry.message);
        socketService.emitLog(jobId, logEntry);
      } else {
        console.warn('[DeploymentService] No jobId provided, cannot emit log via WebSocket');
      }
      
      // Update job with logs incrementally if callback provided
      if (onLogUpdate && typeof onLogUpdate === 'function') {
        // Call callback to update job with current logs
        onLogUpdate([...logs]).catch(err => {
          console.error('Error updating deployment job logs:', err);
        });
      }
    };
    
    try {
      // Check if Stellar CLI is available
      if (!stellarAvailable) {
        log('error', 'Stellar CLI not available. Please install it first.');
        throw new Error('Stellar CLI not installed');
      }

      // Check Stellar CLI configuration
      const configCheck = await this.checkStellarConfig(network);
      if (!configCheck.success) {
        log('error', `Stellar CLI configuration check failed: ${configCheck.error}`);
        throw new Error(`Configuration check failed: ${configCheck.error}`);
      }

      log('info', `Starting deployment to ${network}...`);

      // Ensure default keypair exists (throws with CLI detail on failure)
      await this.ensureDefaultKeypair(network);

      // For testnet, ensure the account has enough XLM for deployment
      if (network === 'testnet') {
        try {
          log('info', 'Ensuring testnet account has sufficient XLM...');
          const env = getStellarEnv(network);
          await execAsync(`stellar keys fund ${this.defaultKeypairName} --network ${network}`, { env });
          log('info', 'Account funding verified/completed');
        } catch (fundError) {
          log('warning', `Account funding failed: ${fundError.message}`);
          // Don't fail deployment - the account might already be funded
        }
      }

      // Create project directory
      const projectDir = path.join(this.tempDir, projectId);
      await fs.remove(projectDir);
      await fs.ensureDir(projectDir);

      // Write WASM file
      const wasmBuffer = Buffer.from(wasmBase64, 'base64');
      const wasmPath = path.join(projectDir, 'contract.wasm');
      await fs.writeFile(wasmPath, wasmBuffer);
      log('info', `WASM file written: ${wasmBuffer.length} bytes`);

      // Validate WASM file
      const validation = this.validateWasmFile(wasmBuffer);
      if (!validation.valid) {
        log('error', `WASM validation failed: ${validation.errors.join(', ')}`);
        throw new Error(`Invalid WASM file: ${validation.errors.join(', ')}`);
      }
      
      log('info', `WASM validation passed: magic=${validation.magic}, version=${validation.version}, size=${validation.size} bytes`);

      // Check if WASM file was written correctly
      const stats = await fs.stat(wasmPath);
      log('info', `WASM file size on disk: ${stats.size} bytes`);
      
      if (stats.size !== wasmBuffer.length) {
        log('error', `WASM file size mismatch: expected ${wasmBuffer.length}, got ${stats.size}`);
        throw new Error('WASM file write failed');
      }

      // Get the wallet address
      const { stdout: addressOutput } = await execAsync(`stellar keys address ${this.defaultKeypairName}`);
      const walletAddress = addressOutput.trim();
      log('info', `Using wallet address: ${walletAddress}`);

      // Verify keypair exists and is accessible
      try {
        await execAsync(`stellar keys show ${this.defaultKeypairName}`);
        log('info', `Keypair ${this.defaultKeypairName} verified successfully`);
      } catch (keypairError) {
        log('error', `Keypair ${this.defaultKeypairName} not accessible: ${keypairError.message}`);
        throw new Error(`Keypair not accessible: ${keypairError.message}`);
      }

      

      // Deploy the contract
      log('info', 'Deploying contract...');
      

      
      const deployCommand = `stellar contract deploy --wasm ${wasmPath} --source-account ${this.defaultKeypairName} --network ${network} --alias ${projectId}`;
      
      log('debug', `Deploy command: ${deployCommand}`);
      
      // Execute deployment command with real-time output streaming (passphrase required when using RPC)
      const deployEnv = getStellarEnv(network);
      const deployProcess = spawn('stellar', [
        'contract', 'deploy',
        '--wasm', wasmPath,
        '--source-account', this.defaultKeypairName,
        '--network', network,
        '--alias', projectId
      ], { stdio: ['pipe', 'pipe', 'pipe'], env: deployEnv });

      let deployOutput = '';
      let deployError = '';

      // Stream stdout in real-time
      deployProcess.stdout.on('data', (data) => {
        const output = data.toString();
        deployOutput += output;
        
        // Log each line in real-time
        output.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (trimmed) {
            const lower = trimmed.toLowerCase();
            if (lower.includes('error') || lower.includes('failed')) {
              log('error', trimmed);
            } else if (lower.includes('warning')) {
              log('warning', trimmed);
            } else if (lower.includes('success') || lower.includes('deployed') || lower.includes('contract')) {
              log('success', trimmed);
            } else {
              log('info', trimmed);
            }
          }
        });
      });

      // Stream stderr in real-time
      deployProcess.stderr.on('data', (data) => {
        const error = data.toString();
        deployError += error;
        
        // Log each line in real-time
        error.split('\n').forEach(line => {
          const trimmed = line.trim();
          if (trimmed && !trimmed.includes('Build Complete')) {
            const lower = trimmed.toLowerCase();
            if (lower.includes('error') || lower.includes('failed')) {
              log('error', trimmed);
            } else {
              log('warning', trimmed);
            }
          }
        });
      });

      // Wait for deployment to complete
      await new Promise((resolve, reject) => {
        deployProcess.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Deployment process exited with code ${code}`));
          }
        });
      });

      // Extract contract ID from output
      const contractId = this.extractContractId(deployOutput);
      if (!contractId) {
        log('error', 'Failed to extract contract ID from deployment output');
        log('error', `Deployment output: ${deployOutput}`);
        throw new Error('Failed to extract contract ID from deployment output');
      }

      log('success', `Contract deployed successfully with ID: ${contractId}`);



      return {
        success: true,
        logs,
        contractAddress: contractId,
        network,
        projectId,
        walletAddress,
        keypairName: this.defaultKeypairName
      };

    } catch (error) {
      log('error', `Deployment failed: ${error.message}`);
      

      
      return {
        success: false,
        logs,
        error: error.message
      };
    } finally {
      // Cleanup
      try {
        const projectDir = path.join(this.tempDir, projectId);
        await fs.remove(projectDir);
      } catch (e) {
        console.error('Cleanup error:', e);
      }
    }
  }

  /**
   * Invoke a contract function using Soroban RPC (SDK-based, no CLI required)
   */
  async invokeContract(contractId, functionName, args = [], sourceAccount = null, network = 'testnet') {
    const logs = [];
    
    const log = (type, message) => {
      const logEntry = {
        type,
        message,
        timestamp: new Date().toISOString()
      };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
    };

    try {
      log('info', `Invoking contract function: ${functionName}`);
      log('info', `Contract ID: ${contractId}`);

      // Use Soroban RPC instead of CLI
      const sorobanRpcUrl = network === 'testnet' 
        ? 'https://soroban-testnet.stellar.org'
        : 'https://soroban-mainnet.stellar.org';
      
      // Check if SorobanRpc is available in SDK
      let SorobanRpc;
      try {
        SorobanRpc = StellarSdk.SorobanRpc || StellarSdk.rpc;
        if (!SorobanRpc) {
          throw new Error('SorobanRpc not available in SDK');
        }
      } catch (sdkError) {
        log('warning', 'SorobanRpc not available, falling back to CLI');
        if (stellarAvailable) {
          return this.invokeContractCLI(contractId, functionName, args, sourceAccount, network);
        }
        throw new Error('Soroban RPC not available and CLI not installed. Please install Stellar CLI or update SDK.');
      }

      const server = new SorobanRpc.Server(sorobanRpcUrl);
      log('info', `Using Soroban RPC: ${sorobanRpcUrl}`);

      // Get the default keypair for signing
      let keypair;
      try {
        // Try to get keypair from CLI first (if available)
        if (stellarAvailable) {
          const sourceKeypair = sourceAccount || this.defaultKeypairName;
          const { stdout: secretKey } = await execAsync(`stellar keys show ${sourceKeypair} --secret`);
          const secretKeyStr = secretKey.trim();
          if (secretKeyStr && secretKeyStr.startsWith('S') && secretKeyStr.length === 56) {
            keypair = StellarSdk.Keypair.fromSecret(secretKeyStr);
          } else {
            throw new Error('Invalid secret key format from CLI');
          }
        } else {
          // If CLI not available, use environment variable
          const secretKey = process.env.DEPLOY_SECRET_KEY;
          if (secretKey && secretKey.startsWith('S') && secretKey.length === 56) {
            log('info', 'Using keypair from DEPLOY_SECRET_KEY environment variable');
            keypair = StellarSdk.Keypair.fromSecret(secretKey);
          } else {
            // Generate a new keypair for this invocation (read-only operations)
            log('warning', 'No valid keypair found, generating temporary keypair for read-only operation');
            keypair = StellarSdk.Keypair.random();
            log('info', `Generated temporary keypair: ${keypair.publicKey()}`);
          }
        }
      } catch (keypairError) {
        log('warning', `Failed to load keypair: ${keypairError.message}`);
        // Generate a new keypair as fallback
        try {
          log('info', 'Generating temporary keypair as fallback');
          keypair = StellarSdk.Keypair.random();
          log('info', `Generated fallback keypair: ${keypair.publicKey()}`);
        } catch (genError) {
          log('error', `Failed to generate keypair: ${genError.message}`);
          throw new Error('Unable to create keypair for contract invocation. Please set DEPLOY_SECRET_KEY environment variable or install Stellar CLI.');
        }
      }

      const sourceAccountAddress = keypair.publicKey();
      log('info', `Source account: ${sourceAccountAddress}`);

      // Get account from RPC server
      let account;
      try {
        account = await server.getAccount(sourceAccountAddress);
      } catch (accountError) {
        // If account doesn't exist, we need to fund it or use a different approach
        // For testnet, try to get a friendbot-funded account or use a well-known test account
        log('warning', `Account ${sourceAccountAddress} not found on network`);
        
        // Try to get a minimal account for simulation
        // Use the SDK's Account class to create a minimal account
        try {
          // Create a new account object with sequence 0 for simulation
          account = new StellarSdk.Account(sourceAccountAddress, '0');
        } catch (accError) {
          log('error', `Failed to create account object: ${accError.message}`);
          throw new Error(`Account ${sourceAccountAddress} does not exist on network. Please fund the account or set DEPLOY_SECRET_KEY to a funded account's secret key.`);
        }
      }
      
      // Create contract instance
      const contract = new StellarSdk.Contract(contractId);
      
      // Convert args to ScVal format
      const scValArgs = args.map(arg => {
        try {
          // Try to parse as number
          if (typeof arg === 'string' && !isNaN(arg) && !isNaN(parseFloat(arg))) {
            const num = parseInt(arg);
            return StellarSdk.nativeToScVal(num, { type: 'i128' });
          }
          // Try as symbol (for simple string args like "gm")
          if (typeof arg === 'string') {
            // Use symbol_short for short strings
            return StellarSdk.nativeToScVal(arg, { type: 'symbol' });
          }
          return StellarSdk.nativeToScVal(arg);
        } catch (e) {
          log('warning', `Could not convert arg ${arg}: ${e.message}, using as string`);
          try {
            return StellarSdk.nativeToScVal(String(arg), { type: 'string' });
          } catch (strError) {
            log('error', `Failed to convert arg to string: ${strError.message}`);
            throw new Error(`Invalid argument format: ${arg}`);
          }
        }
      });

      // Build transaction using contract.call()
      const networkPassphrase = network === 'testnet' 
        ? StellarSdk.Networks.TESTNET 
        : StellarSdk.Networks.PUBLIC;

      let transaction = new StellarSdk.TransactionBuilder(account, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: networkPassphrase
      })
        .addOperation(contract.call(functionName, ...scValArgs))
        .setTimeout(30)
        .build();

      // Simulate transaction
      log('info', 'Simulating transaction...');
      const simulateResponse = await server.simulateTransaction(transaction);
      
      if (simulateResponse.errorResult) {
        const errorStr = JSON.stringify(simulateResponse.errorResult);
        log('error', `Simulation failed: ${errorStr}`);
        throw new Error(`Simulation failed: ${errorStr}`);
      }

      // Get result from simulation
      let output = null;
      if (simulateResponse.result && simulateResponse.result.retval) {
        try {
          const retval = simulateResponse.result.retval;
          
          // retval is a base64-encoded XDR ScVal, decode it
          let scVal;
          try {
            // Try to decode from base64 XDR
            scVal = StellarSdk.xdr.ScVal.fromXDR(retval, 'base64');
          } catch (xdrError) {
            // If that fails, retval might already be an object
            scVal = retval;
          }
          
          // Try to convert ScVal to readable format
          if (scVal && typeof scVal.switch === 'function') {
            const scValType = scVal.switch();
            if (scValType === StellarSdk.xdr.ScValType.scvSymbol()) {
              output = scVal.sym().toString();
            } else if (scValType === StellarSdk.xdr.ScValType.scvString()) {
              output = scVal.str().toString();
            } else if (scValType === StellarSdk.xdr.ScValType.scvI128()) {
              // Handle i128 - it's a struct with high and low parts
              const i128 = scVal.i128();
              if (i128 && i128.hi && i128.lo !== undefined) {
                // Convert to BigInt for large numbers
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
              // For other types, try to stringify
              try {
                output = JSON.stringify(scVal);
              } catch (e) {
                output = scVal.toString();
              }
            }
          } else if (scVal) {
            // If it's not an ScVal object, try to stringify
            output = typeof scVal === 'string' ? scVal : JSON.stringify(scVal);
          }
        } catch (decodeError) {
          log('warning', `Could not decode result: ${decodeError.message}`);
          log('warning', `Result structure: ${JSON.stringify(simulateResponse.result)}`);
          output = 'Unable to decode result (check logs for details)';
        }
      }
      
      // If no output was decoded, indicate success but no return value
      if (output === null) {
        output = 'Function executed successfully (no return value)';
      }

      log('success', 'Contract function invoked successfully');
      log('info', `Output: ${output}`);

      return {
        success: true,
        logs,
        output: output,
        contractId,
        functionName,
        args
      };

    } catch (error) {
      log('error', `Contract invocation failed: ${error.message}`);
      log('error', `Stack: ${error.stack}`);
      
      // Fallback to CLI if SDK method fails and CLI is available
      if (stellarAvailable) {
        log('info', 'Falling back to CLI method...');
        return this.invokeContractCLI(contractId, functionName, args, sourceAccount, network);
      }
      
      return {
        success: false,
        logs,
        error: error.message
      };
    }
  }

  /**
   * Invoke a contract function using CLI (fallback method)
   */
  async invokeContractCLI(contractId, functionName, args = [], sourceAccount = null, network = 'testnet') {
    const logs = [];
    
    const log = (type, message) => {
      const logEntry = {
        type,
        message,
        timestamp: new Date().toISOString()
      };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
    };

    try {
      log('info', `Invoking contract function via CLI: ${functionName}`);
      log('info', `Contract ID: ${contractId}`);

      const sourceKeypair = sourceAccount || this.defaultKeypairName;

      // Build invoke command
      let invokeCommand = `stellar contract invoke --id ${contractId} --source-account ${sourceKeypair} --network ${network} -- ${functionName}`;
      
      // Add arguments if provided
      if (args && args.length > 0) {
        args.forEach(arg => {
          invokeCommand += ` ${arg}`;
        });
      }

      log('info', `Invoke command: ${invokeCommand}`);
      
      const env = getStellarEnv(network);
      const { stdout, stderr } = await execAsync(invokeCommand, { env });
      
      if (stderr) {
        log('warning', `Stderr: ${stderr}`);
      }

      log('success', 'Contract function invoked successfully');
      log('info', `Output: ${stdout}`);

      return {
        success: true,
        logs,
        output: stdout.trim(),
        contractId,
        functionName,
        args
      };

    } catch (error) {
      log('error', `Contract invocation failed: ${error.message}`);
      
      return {
        success: false,
        logs,
        error: error.message
      };
    }
  }

  /**
   * Install WASM to network (equivalent to upload)
   */
  async uploadWasm(wasmBase64, sourceAccount = null, network = 'testnet') {
    const logs = [];
    
    const log = (type, message) => {
      const logEntry = {
        type,
        message,
        timestamp: new Date().toISOString()
      };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
    };

    try {
      // Create temporary WASM file
      const tempDir = path.join(os.tmpdir(), `wasm-upload-${Date.now()}`);
      await fs.ensureDir(tempDir);
      const wasmPath = path.join(tempDir, 'contract.wasm');
      
      const wasmBuffer = Buffer.from(wasmBase64, 'base64');
      await fs.writeFile(wasmPath, wasmBuffer);
      
      log('info', 'Installing WASM to network...');
      
      // Validate WASM file
      const validation = this.validateWasmFile(wasmBuffer);
      if (!validation.valid) {
        log('error', `WASM validation failed: ${validation.errors.join(', ')}`);
        throw new Error(`Invalid WASM file: ${validation.errors.join(', ')}`);
      }
      
      log('info', `WASM validation passed: magic=${validation.magic}, version=${validation.version}, size=${validation.size} bytes`);
      
      const sourceKeypair = sourceAccount || this.defaultKeypairName;
      const installCommand = `stellar contract install --network ${network} --source-account ${sourceKeypair} --wasm ${wasmPath}`;
      
      log('debug', `Install command: ${installCommand}`);
      
      const env = getStellarEnv(network);
      const { stdout, stderr } = await execAsync(installCommand, { env });
      
      if (stderr) {
        log('warning', `Stderr: ${stderr}`);
      }

      // Extract WASM hash from output
      const wasmHash = this.extractWasmHash(stdout);
      
      if (!wasmHash) {
        log('error', 'Failed to extract WASM hash from install output');
        log('error', `Install output: ${stdout}`);
        throw new Error('Failed to extract WASM hash from install output');
      }

      log('success', `WASM installed successfully with hash: ${wasmHash}`);

      return {
        success: true,
        logs,
        wasmHash,
        network
      };

    } catch (error) {
      log('error', `WASM install failed: ${error.message}`);
      
      return {
        success: false,
        logs,
        error: error.message
      };
    } finally {
      // Cleanup
      try {
        const tempDir = path.join(os.tmpdir(), `wasm-upload-${Date.now()}`);
        await fs.remove(tempDir);
      } catch (e) {
        console.error('Cleanup error:', e);
      }
    }
  }

  /**
   * Deploy using WASM hash (alternative to direct WASM deployment)
   */
  async deployWithWasmHash(wasmHash, alias, sourceAccount = null, network = 'testnet') {
    const logs = [];
    
    const log = (type, message) => {
      const logEntry = {
        type,
        message,
        timestamp: new Date().toISOString()
      };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
    };

    try {
      log('info', `Deploying contract with WASM hash: ${wasmHash}`);
      
      // Validate WASM hash format
      if (!wasmHash || wasmHash.length !== 64 || !/^[a-f0-9]{64}$/.test(wasmHash)) {
        log('error', 'Invalid WASM hash format');
        throw new Error('Invalid WASM hash format');
      }
      
      const sourceKeypair = sourceAccount || this.defaultKeypairName;
      const deployCommand = `stellar contract deploy --wasm-hash ${wasmHash} --source-account ${sourceKeypair} --network ${network} --alias ${alias}`;
      
      log('debug', `Deploy command: ${deployCommand}`);
      
      const env = getStellarEnv(network);
      const { stdout, stderr } = await execAsync(deployCommand, { env });
      
      if (stderr) {
        log('warning', `Stderr: ${stderr}`);
      }

      // Extract contract ID from output
      const contractId = this.extractContractId(stdout);
      
      if (!contractId) {
        log('error', 'Failed to extract contract ID from deployment output');
        log('error', `Deployment output: ${stdout}`);
        throw new Error('Failed to extract contract ID from deployment output');
      }

      log('success', `Contract deployed successfully with ID: ${contractId}`);

      return {
        success: true,
        logs,
        contractAddress: contractId,
        network,
        alias,
        wasmHash
      };

    } catch (error) {
      log('error', `Deployment failed: ${error.message}`);
      
      return {
        success: false,
        logs,
        error: error.message
      };
    }
  }

  /**
   * Get network information
   */
  async getNetworkInfo(network = 'testnet') {
    try {
      const { stdout } = await execAsync('stellar network ls');
      return {
        success: true,
        network,
        info: stdout
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Get default keypair information
   */
  async getDefaultKeypairInfo() {
    try {
      const { stdout } = await execAsync(`stellar keys address ${this.defaultKeypairName}`);
      const address = stdout.trim();
      
      return {
        success: true,
        keypair: {
          name: this.defaultKeypairName,
          address
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Extract contract ID from CLI output
   */
  extractContractId(output) {
    const lines = output.split('\n');
    
    for (const line of lines) {
      // Look for contract ID starting with C
      if (line.trim().startsWith('C') && line.trim().length > 50) {
        return line.trim();
      }
      
      // Look for "Contract ID:" format
      if (line.includes('Contract ID:')) {
        const contractId = line.split('Contract ID:')[1].trim();
        if (contractId && contractId.startsWith('C')) {
          return contractId;
        }
      }
      
      // Look for "id:" format
      if (line.includes('id:') && line.includes('C')) {
        const match = line.match(/id:\s*(C[A-Z0-9]+)/);
        if (match && match[1]) {
          return match[1];
        }
      }
      
      // Look for JSON format
      if (line.includes('"id"') && line.includes('C')) {
        const match = line.match(/"id":\s*"(C[A-Z0-9]+)"/);
        if (match && match[1]) {
          return match[1];
        }
      }
    }
    
    return null;
  }

  /**
   * Extract WASM hash from CLI output
   */
  extractWasmHash(output) {
    // Look for a 64-character hex string (wasm hash)
    const hashMatch = output.match(/[a-f0-9]{64}/);
    if (hashMatch) {
      return hashMatch[0];
    }
    return null;
  }
}

module.exports = new DeploymentService(); 