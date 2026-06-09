/**
 * Multi-file `cargo test` runner.
 *
 * Materializes the full project tree (same build-context assembly as compile),
 * runs `cargo test` across the crate/workspace, and parses libtest's human
 * output into per-test results mapped back to the SOURCE FILE each test lives
 * in — so unit tests (#[cfg(test)] modules anywhere under src/) and integration
 * tests (files under tests/) both show up against the right file, and the
 * "Tests N/M" counter reflects the real discovered test count.
 */
import { spawn } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import socketService from './socketService';
import { materializeTree, validateProject, type IncomingFile } from './projectLayout';
import { normalizeFiles } from './projectLayout';
import { dirOfPath, DEFAULT_MANIFEST_PATH, type TreeFile } from '../lib/paths';
import type { LogEntry } from './compilationService';

type LogFn = (type: string, message: string) => void;
type LogUpdateCallback = (logs: LogEntry[]) => Promise<any>;

export interface TestCase {
  /** Source file the test maps to, e.g. "src/storage.rs" or "tests/integration.rs". */
  file?: string;
  /** Full test path as libtest reports it, e.g. "storage::tests::increments". */
  name: string;
  passed: boolean;
  ignored?: boolean;
  durationMs?: number;
  /** Captured failure output (panic message / assertion), if it failed. */
  output?: string;
}

export interface TestResult {
  success: boolean;
  /** total discovered (passed + failed + ignored) */
  total: number;
  passed: number;
  failed: number;
  ignored: number;
  tests: TestCase[];
  logs: LogEntry[];
  error?: string;
  /** true when the test binary failed to even compile */
  compileFailed?: boolean;
}

export interface TestOptions {
  manifestPath?: string;
  deployTarget?: string | null;
}

const RUNNING = /^\s*Running\s+(?:unittests\s+)?(\S+)\s+\(/;
const TEST_LINE = /^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED|ignored)(?:\s+<([0-9.]+)s>)?\s*$/;
const RESULT_LINE = /^test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored/;

/**
 * Map a libtest test path (e.g. "storage::tests::increments") to the source
 * file that declares it, using the actual file tree. Walks the module path and
 * returns the longest prefix that resolves to a real file; falls back to the
 * running binary's source file (lib.rs for unit tests, the integration file for
 * integration tests).
 */
function mapTestToFile(testName: string, runningSrc: string | null, files: TreeFile[]): string | undefined {
  const paths = new Set(files.map((f) => f.path));
  const segments = testName.split('::');
  segments.pop(); // drop the test fn name; what remains is the module path

  // Unit tests run from the crate root (src/); integration tests from their own
  // file directory. Derive the search base from the running binary's source.
  const runBase = runningSrc ? dirOfPath(runningSrc) : 'src';
  const baseDir = runBase || 'src';

  let best: string | undefined;
  let acc = baseDir;
  for (const seg of segments) {
    const candFile = acc ? `${acc}/${seg}.rs` : `${seg}.rs`;
    const candMod = acc ? `${acc}/${seg}/mod.rs` : `${seg}/mod.rs`;
    if (paths.has(candFile)) {
      best = candFile;
      acc = `${acc}/${seg}`; // continue descending in case of deeper modules
    } else if (paths.has(candMod)) {
      best = candMod;
      acc = `${acc}/${seg}`;
    } else {
      break; // inline module (e.g. #[cfg(test)] mod tests) — stop descending
    }
  }

  if (best) return best;
  // Fall back to the running binary's source file when nothing resolved
  // (e.g. tests defined directly in lib.rs, or an inline test module).
  return runningSrc || undefined;
}

class TestService {
  tempDir: string;

  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'soroban-test');
  }

  async runTests(
    projectId: string,
    files: IncomingFile[],
    onLogUpdate: LogUpdateCallback | null = null,
    jobId: string | null = null,
    opts: TestOptions = {}
  ): Promise<TestResult> {
    const manifestPath = opts.manifestPath || DEFAULT_MANIFEST_PATH;
    const buildKey = jobId || projectId;
    const projectDir = path.join(this.tempDir, buildKey);
    const logs: LogEntry[] = [];

    const log: LogFn = (type, message) => {
      const entry: LogEntry = { type, message, timestamp: new Date().toISOString() };
      logs.push(entry);
      console.log(`[TEST ${type.toUpperCase()}] ${message}`);
      if (jobId) {
        try {
          socketService.emitLog(jobId, entry);
        } catch (err) {
          console.error(`[TestService] emitLog error for ${jobId}:`, err);
        }
      }
      if (onLogUpdate) onLogUpdate([...logs]).catch((e: any) => console.error('test log update error:', e));
    };

    let tree: TreeFile[];
    try {
      await fs.remove(projectDir);
      await fs.ensureDir(projectDir);
      tree = normalizeFiles(files);
      await materializeTree(projectDir, files);
    } catch (e: any) {
      log('error', `Invalid project file path: ${e.message}`);
      return { success: false, total: 0, passed: 0, failed: 0, ignored: 0, tests: [], logs, error: e.message };
    }

    // Light pre-flight: tests require a manifest. (Unlike compile we don't force
    // a #[contract] entrypoint — a crate can be tests-only.)
    const validation = validateProject(files, manifestPath);
    const manifestMissing = validation.errors.find((e) => e.startsWith('Manifest not found'));
    if (manifestMissing) {
      log('error', manifestMissing);
      return { success: false, total: 0, passed: 0, failed: 0, ignored: 0, tests: [], logs, error: manifestMissing };
    }

    const relBuildDir = validation.buildDir;
    const buildDir = relBuildDir ? path.join(projectDir, relBuildDir) : projectDir;

    log('info', 'Running cargo test…');

    // `--no-fail-fast` so every test runs even when one fails; scope to the
    // deploy target package for a workspace so we test the relevant crate.
    const args = ['test', '--no-fail-fast'];
    if (validation.isWorkspace && opts.deployTarget) {
      args.push('-p', opts.deployTarget);
    }

    try {
      const result = await this.spawnCargoTest(buildDir, args, tree, logs, log);
      return result;
    } catch (e: any) {
      log('error', `Test run failed: ${e.message}`);
      return { success: false, total: 0, passed: 0, failed: 0, ignored: 0, tests: [], logs, error: e.message };
    } finally {
      try {
        await fs.remove(projectDir);
      } catch (err) {
        console.error('[TestService] cleanup error:', err);
      }
    }
  }

  private spawnCargoTest(
    buildDir: string,
    args: string[],
    tree: TreeFile[],
    logs: LogEntry[],
    log: LogFn
  ): Promise<TestResult> {
    const targetDir = path.join(buildDir, 'target');

    return new Promise((resolve, reject) => {
      const proc = spawn('cargo', args, {
        cwd: buildDir,
        env: { ...process.env, CARGO_TARGET_DIR: targetDir, HOME: buildDir, USER: 'root' },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Collect every line in arrival order across both streams so a "Running
      // <src>" line stays associated with the test lines that follow it.
      const allLines: string[] = [];
      let stdoutBuf = '';
      let stderrBuf = '';
      const onChunk = (which: 'out' | 'err') => (data: Buffer) => {
        const text = data.toString();
        const buf = which === 'out' ? stdoutBuf + text : stderrBuf + text;
        const parts = buf.split('\n');
        const remainder = parts.pop() ?? '';
        if (which === 'out') stdoutBuf = remainder;
        else stderrBuf = remainder;
        for (const line of parts) {
          allLines.push(line);
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Surface meaningful lines to the live log (skip pure noise).
          const lower = trimmed.toLowerCase();
          if (TEST_LINE.test(trimmed) || RESULT_LINE.test(trimmed)) log('info', trimmed);
          else if (lower.startsWith('error') || lower.includes('panicked at')) log('error', trimmed);
          else if (lower.includes('warning')) log('warning', trimmed);
          else if (lower.startsWith('running') || lower.startsWith('compiling') || lower.startsWith('finished'))
            log('info', trimmed);
        }
      };

      proc.stdout.on('data', onChunk('out'));
      proc.stderr.on('data', onChunk('err'));

      proc.on('error', (err) => reject(err));

      proc.on('close', (code) => {
        if (stdoutBuf.trim()) allLines.push(stdoutBuf);
        if (stderrBuf.trim()) allLines.push(stderrBuf);

        const parsed = this.parseTestOutput(allLines, tree);

        // A non-zero exit with zero parsed tests means the test binary failed to
        // COMPILE (vs. tests ran and some failed). Distinguish for the UI.
        const compileFailed = code !== 0 && parsed.tests.length === 0;
        if (compileFailed) {
          log('error', 'Tests failed to compile.');
          resolve({
            success: false,
            total: 0,
            passed: 0,
            failed: 0,
            ignored: 0,
            tests: [],
            logs,
            compileFailed: true,
            error: 'Tests failed to compile'
          });
          return;
        }

        const success = parsed.failed === 0;
        log(success ? 'success' : 'error', `Tests: ${parsed.passed}/${parsed.total} passed${parsed.failed ? `, ${parsed.failed} failed` : ''}.`);
        resolve({ success, ...parsed, logs });
      });
    });
  }

  /** Parse collected cargo-test lines into structured per-test results. */
  parseTestOutput(lines: string[], tree: TreeFile[]) {
    const tests: TestCase[] = [];
    let runningSrc: string | null = null;

    // First pass: collect test outcomes with their source file association.
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      const trimmed = line.trim();

      const run = RUNNING.exec(trimmed);
      if (run) {
        runningSrc = run[1];
        continue;
      }
      const t = TEST_LINE.exec(trimmed);
      if (t) {
        const name = t[1];
        const status = t[2];
        const durationMs = t[3] ? Math.round(parseFloat(t[3]) * 1000) : undefined;
        tests.push({
          name,
          file: mapTestToFile(name, runningSrc, tree),
          passed: status === 'ok',
          ignored: status === 'ignored',
          durationMs
        });
      }
    }

    // Second pass: attach failure output blocks ("---- <name> stdout ----").
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].trim().match(/^----\s+(.+?)\s+stdout\s+----$/);
      if (!m) continue;
      const name = m[1];
      const out: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j].trim();
        if (l === '' || /^----\s+.+\s+stdout\s+----$/.test(l) || /^failures:$/.test(l) || /^test result:/.test(l))
          break;
        out.push(lines[j]);
      }
      const tc = tests.find((x) => x.name === name);
      if (tc) tc.output = out.join('\n').trim();
    }

    const passed = tests.filter((t) => t.passed && !t.ignored).length;
    const ignored = tests.filter((t) => t.ignored).length;
    const failed = tests.filter((t) => !t.passed && !t.ignored).length;
    const total = tests.length;
    return { total, passed, failed, ignored, tests };
  }
}

export default new TestService();
