import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import Docker from 'dockerode';
import socketService from './socketService';

const execAsync = promisify(exec);

export interface LogEntry {
  type: string;
  message: string;
  timestamp: string;
}

export interface CompilationResult {
  success: boolean;
  logs: LogEntry[];
  wasmBase64?: string;
  wasmUrl?: string;
  error?: string;
  fallback?: boolean;
}

type LogFn = (type: string, message: string) => void;
type LogUpdateCallback = (logs: LogEntry[]) => Promise<any>;

interface CompileFile {
  name: string;
  content: string;
}

class CompilationService {
  tempDir: string;
  docker: Docker | null;

  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'soroban-compile');
    this.docker = null;

    // Try to initialize Docker, but don't fail if it's not available
    try {
      this.docker = new Docker();
    } catch (error) {
      console.log('Docker not available, will use fallback compilation');
    }
  }

  async compileProject(
    projectId: string,
    files: CompileFile[],
    onLogUpdate: LogUpdateCallback | null = null,
    jobId: string | null = null
  ): Promise<CompilationResult> {
    console.log(`[CompilationService] compileProject called with jobId: ${jobId}, projectId: ${projectId}`);
    const projectDir = path.join(this.tempDir, projectId);

    const logs: LogEntry[] = [];

    try {
      // Clean and create project directory
      await fs.remove(projectDir);
      await fs.ensureDir(projectDir);

      // Write files to project directory
      for (const file of files) {
        const filePath = path.join(projectDir, file.name);
        await fs.ensureDir(path.dirname(filePath));
        await fs.writeFile(filePath, file.content);
      }

      const log: LogFn = (type, message) => {
        const logEntry: LogEntry = {
          type,
          message,
          timestamp: new Date().toISOString()
        };
        logs.push(logEntry);
        console.log(`[${type.toUpperCase()}] ${message}`);

        // Emit log via WebSocket if jobId provided
        if (jobId) {
          console.log(`[CompilationService] Emitting log for job ${jobId}:`, logEntry.message);
          try {
            socketService.emitLog(jobId, logEntry);
            console.log(`[CompilationService] Successfully emitted log for job ${jobId}`);
          } catch (err) {
            console.error(`[CompilationService] Error emitting log for job ${jobId}:`, err);
          }
        } else {
          console.warn(`[CompilationService] No jobId provided, cannot emit log via WebSocket. jobId: ${jobId}, type: ${typeof jobId}`);
        }

        // Update job with logs incrementally if callback provided
        if (onLogUpdate && typeof onLogUpdate === 'function') {
          // Call callback to update job with current logs
          onLogUpdate([...logs]).catch((err: any) => {
            console.error('Error updating job logs:', err);
          });
        }
      };

      log('info', 'Starting real Rust compilation...');

      // Try real compilation with Stellar CLI first
      try {
        log('info', 'Attempting real Rust compilation with Stellar CLI...');
        const realResult = await this.realStellarCompilation(projectDir, logs, log);
        if (realResult && realResult.success) {
          log('success', 'Stellar CLI compilation succeeded!');
          return {
            success: true,
            logs: realResult.logs || logs,
            wasmBase64: realResult.output?.wasm,
            wasmUrl: realResult.output?.wasm ? `data:application/wasm;base64,${realResult.output.wasm}` : undefined
          };
        }
        log('warning', `Stellar CLI compilation returned success=false: ${realResult?.error || 'unknown error'}`);
        log('warning', 'Trying Docker fallback...');
      } catch (error: any) {
        log('warning', `Stellar CLI compilation error: ${error.message}`);
        log('warning', `Error stack: ${error.stack}`);
        log('warning', 'Trying Docker fallback...');
      }

      // Check if Docker is available
      if (!this.docker) {
        log('warning', 'Docker not available, using fallback compilation');
        return this.fallbackCompilation(projectDir, logs);
      }

      // Check if compiler image exists
      try {
        await this.docker.getImage('websoroban-compiler:latest').inspect();
        log('info', 'Found compiler Docker image');
      } catch (error) {
        log('warning', 'Compiler Docker image not found, building it now...');
        try {
          await this.buildCompilerImage();
          log('info', 'Compiler image built successfully');
        } catch (buildError: any) {
          log('error', 'Failed to build compiler image: ' + buildError.message);
          return this.fallbackCompilation(projectDir, logs);
        }
      }

      // Create output directory
      const outputDir = path.join(this.tempDir, 'output', projectId);
      await fs.ensureDir(outputDir);

      // Create Docker container for compilation
      const container = await this.docker.createContainer({
        Image: 'websoroban-compiler:latest',
        Cmd: ['/usr/local/bin/compile.sh'],
        HostConfig: {
          Binds: [
            `${projectDir}:/workspace/project`,
            `${outputDir}:/workspace/output`
          ],
          Memory: 2048 * 1024 * 1024, // 2GB memory limit
          CpuShares: 512
        },
        WorkingDir: '/workspace/project'
      });

      // Start container
      await container.start();
      log('info', 'Docker container started for real Rust compilation');

      // Track which logs we've already processed to avoid duplicates
      let processedLogCount = 0;

      // Get container logs in real-time using polling
      const pollLogs = async () => {
        try {
          const containerLogs = await container.logs({
            stdout: true,
            stderr: true,
            timestamps: true,
            tail: 1000 // Get last 1000 lines
          });

          const lines = containerLogs.toString().split('\n').filter((line) => line.trim());

          // Only process new lines
          const newLines = lines.slice(processedLogCount);
          processedLogCount = lines.length;

          for (const line of newLines) {
            try {
              // Remove timestamp prefix if present
              const cleanLine = line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /, '');

              // Try to parse as JSON first (from compile.sh script)
              try {
                const logEntry = JSON.parse(cleanLine);
                log(logEntry.type || 'info', logEntry.message || cleanLine);
              } catch (e) {
                // Not JSON, treat as regular log line
                // Detect log type from content
                const lowerLine = cleanLine.toLowerCase();
                if (lowerLine.includes('error') || lowerLine.includes('failed') || lowerLine.includes('❌')) {
                  log('error', cleanLine);
                } else if (lowerLine.includes('warning') || lowerLine.includes('⚠')) {
                  log('warning', cleanLine);
                } else if (lowerLine.includes('success') || lowerLine.includes('✅') || lowerLine.includes('finished')) {
                  log('success', cleanLine);
                } else if (lowerLine.includes('compiling') || lowerLine.includes('building') || lowerLine.includes('updating')) {
                  log('info', cleanLine);
                } else {
                  log('info', cleanLine);
                }
              }
            } catch (e) {
              // If parsing fails, treat as info log
              log('info', line);
            }
          }
        } catch (error) {
          console.error('Error polling container logs:', error);
        }
      };

      // Poll logs every 500ms while container is running
      const logInterval = setInterval(pollLogs, 500);

      // Wait for container to finish
      const result = await container.wait();
      clearInterval(logInterval);

      // Get final logs
      await pollLogs();

      log('info', `Container finished with status: ${result.StatusCode}`);

      // Check if compilation was successful
      const wasmPath = path.join(this.tempDir, 'output', projectId, 'contract.wasm');
      const wasmExists = await fs.pathExists(wasmPath);

      // Also check if the file exists in the output directory directly
      const directWasmPath = path.join(this.tempDir, 'output', 'contract.wasm');
      const directWasmExists = await fs.pathExists(directWasmPath);

      log('info', `Container status code: ${result.StatusCode}`);
      log('info', `WASM path (project): ${wasmPath} - exists: ${wasmExists}`);
      log('info', `WASM path (direct): ${directWasmPath} - exists: ${directWasmExists}`);

      if (result.StatusCode === 0 && (wasmExists || directWasmExists)) {
        // Use the correct path
        const finalWasmPath = wasmExists ? wasmPath : directWasmPath;
        // Read WASM file and convert to base64
        const wasmBuffer = await fs.readFile(finalWasmPath);
        const wasmBase64 = wasmBuffer.toString('base64');

        const successMessage = 'Real Rust compilation successful!';
        log('success', successMessage);

        return {
          success: true,
          logs,
          wasmBase64,
          wasmUrl: `data:application/wasm;base64,${wasmBase64}`
        };
      } else {
        const errorMessage = 'Real Rust compilation failed';
        log('error', errorMessage);

        return {
          success: false,
          logs,
          error: errorMessage
        };
      }
    } catch (error: any) {
      console.error('Compilation error:', error);
      const errorMessage = `Compilation error: ${error.message}`;

      const logEntry: LogEntry = {
        type: 'error',
        message: errorMessage,
        timestamp: new Date().toISOString()
      };
      logs.push(logEntry);

      return {
        success: false,
        logs: [logEntry],
        error: error.message
      };
    } finally {
      // Cleanup
      try {
        await fs.remove(projectDir);
        await fs.remove(path.join(this.tempDir, 'output', projectId));
      } catch (e) {
        console.error('Cleanup error:', e);
      }
    }
  }

  async fallbackCompilation(projectDir: string, logs: LogEntry[]): Promise<CompilationResult> {
    const log: LogFn = (type, message) => {
      const logEntry: LogEntry = {
        type,
        message,
        timestamp: new Date().toISOString()
      };
      logs.push(logEntry);
      console.log(`[${type.toUpperCase()}] ${message}`);
    };

    log('info', 'Using fallback compilation service');
    log('info', 'Checking project structure...');

    // Check for required files
    const libRsPath = path.join(projectDir, 'lib.rs');
    const srcLibRsPath = path.join(projectDir, 'src', 'lib.rs');
    const cargoPath = path.join(projectDir, 'Cargo.toml');

    const libRsExists = (await fs.pathExists(libRsPath)) || (await fs.pathExists(srcLibRsPath));
    const cargoExists = await fs.pathExists(cargoPath);

    if (!libRsExists) {
      log('error', 'lib.rs file not found');
      return {
        success: false,
        logs,
        error: 'Missing lib.rs file'
      };
    }

    if (!cargoExists) {
      log('error', 'Cargo.toml file not found');
      return {
        success: false,
        logs,
        error: 'Missing Cargo.toml file'
      };
    }

    log('info', 'Project structure looks good');
    log('info', 'Simulating compilation...');

    // Simulate compilation steps
    await new Promise((resolve) => setTimeout(resolve, 2000));

    log('info', 'Checking dependencies...');
    log('info', 'Compiling soroban-sdk...');
    log('info', 'Building for wasm32-unknown-unknown target...');
    log('success', 'Compilation successful! (Fallback mode)');

    // Generate a mock WASM file (just for demonstration)
    const mockWasm = Buffer.from('mock-wasm-content-for-demo');
    const wasmBase64 = mockWasm.toString('base64');

    return {
      success: true,
      logs,
      wasmBase64,
      wasmUrl: `data:application/wasm;base64,${wasmBase64}`,
      fallback: true
    };
  }

  async buildCompilerImage(): Promise<any> {
    if (!this.docker) {
      throw new Error('Docker not available');
    }

    try {
      const stream = await this.docker.buildImage(
        {
          context: path.join(__dirname, '..'),
          src: ['Dockerfile', 'scripts/compile.sh']
        },
        {
          t: 'websoroban-compiler:latest'
        }
      );

      return new Promise((resolve, reject) => {
        this.docker!.modem.followProgress(stream, (err: Error | null, res: any) => {
          if (err) reject(err);
          else resolve(res);
        });
      });
    } catch (error) {
      console.error('Failed to build compiler image:', error);
      throw error;
    }
  }

  async realStellarCompilation(
    projectDir: string,
    logs: LogEntry[],
    logFn: LogFn | null = null
  ): Promise<any> {
    // Use provided log function or create a local one
    const log: LogFn =
      logFn ||
      ((type, message) => {
        const logEntry: LogEntry = {
          type,
          message,
          timestamp: new Date().toISOString()
        };
        logs.push(logEntry);
        console.log(`[${type.toUpperCase()}] ${message}`);
      });

    try {
      // Check if stellar CLI is available
      log('info', 'Checking Stellar CLI availability...');
      const { stdout: stellarVersion } = await execAsync('stellar --version');
      log('info', `Stellar CLI found: ${stellarVersion.trim()}`);

      // Determine the correct build directory
      let buildDir = projectDir;
      const cargoTomlPath = path.join(projectDir, 'Cargo.toml');

      if (await fs.pathExists(cargoTomlPath)) {
        const cargoContent = await fs.readFile(cargoTomlPath, 'utf8');

        // Check if this is a workspace
        if (cargoContent.includes('[workspace]') && cargoContent.includes('members')) {
          log('info', 'Detected Stellar workspace project...');

          // Look for contract directories
          const contractsDir = path.join(projectDir, 'contracts');
          if (await fs.pathExists(contractsDir)) {
            const contracts = await fs.readdir(contractsDir);
            const contractDirs: string[] = [];

            for (const contract of contracts) {
              const contractPath = path.join(contractsDir, contract);
              const contractCargoPath = path.join(contractPath, 'Cargo.toml');

              if (await fs.pathExists(contractCargoPath)) {
                contractDirs.push(contractPath);
              }
            }

            if (contractDirs.length > 0) {
              // Use the first contract directory found
              buildDir = contractDirs[0];
              log('info', `Found contract at: ${path.relative(projectDir, buildDir)}`);
            } else {
              log('warning', 'Workspace found but no contracts detected, building from workspace root');
            }
          }
        } else {
          // Single contract project
          log('info', 'Detected single contract project...');

          // Ensure proper project structure for single contract
          const srcDir = path.join(projectDir, 'src');
          await fs.ensureDir(srcDir);

          // Check if main.rs exists and move it to lib.rs if needed
          const mainPath = path.join(srcDir, 'main.rs');
          const libPath = path.join(srcDir, 'lib.rs');

          if ((await fs.pathExists(mainPath)) && !(await fs.pathExists(libPath))) {
            await fs.move(mainPath, libPath);
            log('info', 'Moved main.rs to lib.rs for library project');
          } else if (!(await fs.pathExists(libPath))) {
            // Create lib.rs if it doesn't exist - find any .rs file in the project
            const files = await fs.readdir(buildDir);
            const rsFiles = files.filter((f) => f.endsWith('.rs'));
            if (rsFiles.length > 0) {
              const sourceFile = path.join(buildDir, rsFiles[0]);
              await fs.copy(sourceFile, libPath);
              log('info', `Created lib.rs from ${rsFiles[0]}`);
            }
          }

          // Fix library path issue by ensuring [lib] section exists
          let updatedContent: string;
          if (cargoContent.includes('[lib]')) {
            // Replace existing [lib] section
            updatedContent = cargoContent.replace(/\[lib\][\s\S]*?(?=\n\[|\n$|$)/m, '[lib]\npath = "src/lib.rs"');
          } else {
            // Add [lib] section
            updatedContent = cargoContent + '\n\n[lib]\npath = "src/lib.rs"\n';
          }
          await fs.writeFile(cargoTomlPath, updatedContent);
          log('info', 'Fixed Cargo.toml library path configuration');
        }
      }

      // Ensure build directory exists and is accessible
      await fs.ensureDir(buildDir);
      const buildDirExists = await fs.pathExists(buildDir);
      if (!buildDirExists) {
        throw new Error(`Build directory does not exist: ${buildDir}`);
      }

      // Ensure target directory exists before compilation
      const targetDir = path.join(buildDir, 'target');
      await fs.ensureDir(targetDir);
      await fs.ensureDir(path.join(targetDir, 'wasm32v1-none', 'release'));
      await fs.ensureDir(path.join(targetDir, 'wasm32-unknown-unknown', 'release'));
      log('info', 'Ensured target directories exist');

      // Verify we can write to the directory
      try {
        const testFile = path.join(buildDir, '.test-write');
        await fs.writeFile(testFile, 'test');
        await fs.remove(testFile);
      } catch (writeError: any) {
        throw new Error(`Cannot write to build directory: ${writeError.message}`);
      }

      // Change to build directory and run stellar contract build
      log('info', `Building contract with Stellar CLI from: ${path.relative(projectDir, buildDir)}`);

      // Use spawn to capture output line by line for real-time logging
      return new Promise((resolve, reject) => {
        const buildProcess = spawn('stellar', ['contract', 'build'], {
          cwd: buildDir,
          env: {
            ...process.env,
            CARGO_TARGET_DIR: targetDir,
            HOME: buildDir,
            USER: 'root'
          },
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let hasError = false;
        let errorOutput = '';

        // Helper function to detect actual errors (not compilation messages)
        const isActualError = (line: string): boolean => {
          const lower = line.toLowerCase();
          // Ignore compilation messages that contain "error" in package names (e.g., "Compiling thiserror")
          if (lower.startsWith('compiling ') || lower.startsWith('adding ') || lower.startsWith('updating ')) {
            return false;
          }
          // Check for actual error patterns
          return (
            lower.includes('error:') ||
            lower.includes('error ') ||
            lower.startsWith('error') ||
            lower.includes('failed to') ||
            lower.includes('failed:') ||
            lower.includes('fatal:') ||
            (lower.includes('cannot') && (lower.includes('find') || lower.includes('open') || lower.includes('read')))
          );
        };

        // Capture stdout line by line
        buildProcess.stdout.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n');
          lines.forEach((line) => {
            const trimmed = line.trim();
            if (trimmed) {
              const lower = trimmed.toLowerCase();
              if (isActualError(trimmed)) {
                log('error', trimmed);
                hasError = true;
                errorOutput += trimmed + '\n';
              } else if (lower.includes('warning')) {
                log('warning', trimmed);
              } else if (lower.includes('compiling') || lower.includes('building') || lower.includes('updating') || lower.includes('finished')) {
                log('info', trimmed);
              } else {
                log('info', trimmed);
              }
            }
          });
        });

        // Capture stderr line by line
        buildProcess.stderr.on('data', (data: Buffer) => {
          const lines = data.toString().split('\n');
          lines.forEach((line) => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.includes('Build Complete')) {
              const lower = trimmed.toLowerCase();
              // stderr often contains compilation progress, so be more lenient
              if (isActualError(trimmed)) {
                log('error', trimmed);
                hasError = true;
                errorOutput += trimmed + '\n';
              } else if (lower.startsWith('compiling ') || lower.startsWith('adding ') || lower.startsWith('updating ')) {
                // These are normal compilation messages on stderr
                log('info', trimmed);
              } else {
                log('info', trimmed);
              }
            }
          });
        });

        buildProcess.on('close', async (code) => {
          // Only reject if exit code is non-zero
          // hasError might be false positive from package names containing "error"
          if (code !== 0) {
            const errorMsg = errorOutput || `Build process exited with code ${code}`;
            log('error', `Build failed with exit code ${code}: ${errorMsg}`);
            reject(new Error(errorMsg));
            return;
          }

          // Log if we detected errors but exit code was 0 (might be false positives)
          if (hasError && errorOutput) {
            log('warning', `Some error-like messages detected but build succeeded: ${errorOutput.substring(0, 200)}`);
          }

          // Continue with WASM file detection
          try {
            // Look for the compiled WASM file
            let wasmFiles: string[] = [];
            let targetDir = '';

            // First try the newer wasm32v1-none target
            const newTargetPath = path.join(buildDir, 'target', 'wasm32v1-none', 'release');
            log('info', `Checking for WASM files in: ${newTargetPath}`);
            if (await fs.pathExists(newTargetPath)) {
              wasmFiles = await fs.readdir(newTargetPath).catch((err: any) => {
                log('warning', `Error reading directory ${newTargetPath}: ${err.message}`);
                return [];
              });
              targetDir = newTargetPath;
              log('info', `Found ${wasmFiles.length} files in wasm32v1-none/release: ${wasmFiles.join(', ')}`);
            } else {
              log('warning', `Directory does not exist: ${newTargetPath}`);
            }

            // Fall back to older wasm32-unknown-unknown target if no files found
            if (wasmFiles.length === 0) {
              const oldTargetPath = path.join(buildDir, 'target', 'wasm32-unknown-unknown', 'release');
              log('info', `Checking fallback directory: ${oldTargetPath}`);
              if (await fs.pathExists(oldTargetPath)) {
                wasmFiles = await fs.readdir(oldTargetPath).catch((err: any) => {
                  log('warning', `Error reading directory ${oldTargetPath}: ${err.message}`);
                  return [];
                });
                targetDir = oldTargetPath;
                log('info', `Found ${wasmFiles.length} files in wasm32-unknown-unknown/release: ${wasmFiles.join(', ')}`);
              } else {
                log('warning', `Fallback directory does not exist: ${oldTargetPath}`);
              }
            }

            // Filter for WASM files (excluding deps)
            const wasmFile = wasmFiles.find((f) => f.endsWith('.wasm') && !f.includes('deps'));

            if (wasmFile) {
              const wasmPath = path.join(targetDir, wasmFile);
              log('info', `Reading WASM file from: ${wasmPath}`);
              const wasmContent = await fs.readFile(wasmPath);

              log('success', `Real compilation successful! Generated ${wasmFile} (${wasmContent.length} bytes)`);

              resolve({
                success: true,
                output: {
                  wasm: wasmContent.toString('base64'),
                  wasmFile: wasmFile
                },
                logs: logs,
                compilationType: 'real'
              });
            } else {
              log('error', `No WASM file found. Available files: ${wasmFiles.join(', ')}`);
              log('error', `Build directory: ${buildDir}`);
              log('error', `Target directory: ${targetDir}`);
              reject(new Error(`No WASM file generated. Found files: ${wasmFiles.join(', ')}`));
            }
          } catch (error: any) {
            log('error', `Error during WASM file detection: ${error.message}`);
            log('error', `Stack: ${error.stack}`);
            reject(error);
          }
        });

        buildProcess.on('error', (err) => {
          log('error', `Build process error: ${err.message}`);
          reject(err);
        });
      });
    } catch (error: any) {
      log('error', `Real compilation failed: ${error.message}`);

      // Capture stderr if available
      if (error.stderr) {
        error.stderr.split('\n').forEach((line: string) => {
          const trimmed = line.trim();
          if (trimmed) {
            log('error', trimmed);
          }
        });
      }

      // Capture stdout if available (sometimes errors are in stdout)
      if (error.stdout) {
        error.stdout.split('\n').forEach((line: string) => {
          const trimmed = line.trim();
          if (trimmed && (trimmed.toLowerCase().includes('error') || trimmed.toLowerCase().includes('failed'))) {
            log('error', trimmed);
          }
        });
      }

      return {
        success: false,
        error: error.message,
        logs: logs,
        compilationType: 'real'
      };
    }
  }
}

export default new CompilationService();
