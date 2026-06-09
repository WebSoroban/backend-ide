/**
 * Project layout: turning a flat set of {path, content} files into a real,
 * validated, on-disk Cargo build context for multi-module / workspace contracts.
 *
 * Responsibilities:
 *   - materialize the FULL file tree into a build dir at each file's exact path,
 *     with mkdir -p and a hard containment check (untrusted input — see lib/paths),
 *   - parse Cargo.toml just enough to know: package name, cdylib, [workspace] +
 *     members, and to list deployable crates,
 *   - pre-flight validation with clear, file-attributed errors (manifest exists,
 *     package name present, every `mod NAME;` resolves, a #[contract] entrypoint
 *     exists),
 *   - path-agnostic WASM discovery (find target/.../release/<crate>.wasm by crate
 *     name, not a hard-coded contract.wasm).
 */
import fs from 'fs-extra';
import path from 'path';
import { sanitizeRelPath, dirOfPath, baseName, type TreeFile, toTreeFile, DEFAULT_MANIFEST_PATH } from '../lib/paths';

export interface IncomingFile {
  path?: string | null;
  name?: string | null;
  content?: string | null;
}

export interface CargoManifest {
  isWorkspace: boolean;
  workspaceMembers: string[];
  packageName: string | null;
  /** crate names that are cdylib (deployable contract libs) keyed by build dir */
  hasCdylib: boolean;
}

export interface CrateInfo {
  /** crate / package name (as written in Cargo.toml, may contain hyphens) */
  name: string;
  /** project-relative dir of this crate's Cargo.toml ('' for root) */
  dir: string;
  cdylib: boolean;
  hasEntrypoint: boolean;
}

export interface LayoutValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  isWorkspace: boolean;
  /** project-relative dir of the driving manifest ('' = project root) */
  buildDir: string;
  /** crates discovered (root crate for single-crate; members for a workspace) */
  crates: CrateInfo[];
  /** subset of crates that are deployable (cdylib + a #[contract] entrypoint) */
  deployableCrates: CrateInfo[];
}

/** Normalize incoming records to a de-duplicated TreeFile[] keyed by path. */
export function normalizeFiles(files: IncomingFile[]): TreeFile[] {
  const byPath = new Map<string, TreeFile>();
  for (const f of files || []) {
    const tf = toTreeFile(f); // sanitizes path, throws on traversal/absolute/etc.
    byPath.set(tf.path, tf);
  }
  return [...byPath.values()];
}

/** Look up a file's content by exact path. */
function fileAt(files: TreeFile[], p: string): string | undefined {
  return files.find((f) => f.path === p)?.content;
}

// ---------------------------------------------------------------------------
// Minimal Cargo.toml reader (no TOML dependency; tolerant line scanner).
// ---------------------------------------------------------------------------
function stripInlineComment(line: string): string {
  // Naive: cut at the first '#' that isn't inside quotes. Good enough for the
  // simple manifests this IDE produces.
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inStr = !inStr;
    else if (c === '#' && !inStr) return line.slice(0, i);
  }
  return line;
}

export function parseCargoToml(content: string): CargoManifest {
  const lines = (content || '').split('\n');
  let section = '';
  let isWorkspace = false;
  let packageName: string | null = null;
  let hasCdylib = false;

  // members can span multiple lines; capture the whole [workspace].members array.
  const workspaceMembers: string[] = [];
  const membersArrayMatch = content.match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (membersArrayMatch) {
    for (const m of membersArrayMatch[1].matchAll(/"([^"]+)"/g)) {
      workspaceMembers.push(m[1]);
    }
  }

  for (const rawLine of lines) {
    const line = stripInlineComment(rawLine).trim();
    if (!line) continue;
    const sec = line.match(/^\[+\s*([^\]]+?)\s*\]+$/);
    if (sec) {
      section = sec[1].trim();
      if (section === 'workspace') isWorkspace = true;
      continue;
    }
    if (section === 'package') {
      const nm = line.match(/^name\s*=\s*"([^"]+)"/);
      if (nm) packageName = nm[1];
    }
    if (section === 'lib') {
      if (/crate-type\s*=/.test(line) && line.includes('cdylib')) hasCdylib = true;
    }
  }

  return { isWorkspace, workspaceMembers, packageName, hasCdylib };
}

// ---------------------------------------------------------------------------
// Module (`mod NAME;`) resolution
// ---------------------------------------------------------------------------
const MOD_DECL = /^\s*(?:pub\s*(?:\([^)]*\)\s*)?)?mod\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/;

/**
 * The directory a file's `mod NAME;` declarations resolve against:
 *   - lib.rs / main.rs / mod.rs declare modules in their OWN directory,
 *   - any other `foo.rs` declares modules in a `foo/` subdirectory.
 */
function moduleBaseDir(filePath: string): string {
  const dir = dirOfPath(filePath);
  const leaf = baseName(filePath).replace(/\.rs$/, '');
  if (leaf === 'lib' || leaf === 'main' || leaf === 'mod') return dir;
  return dir ? `${dir}/${leaf}` : leaf;
}

/** Return unresolved `mod NAME;` declarations as human-readable error strings. */
function checkModuleResolution(files: TreeFile[]): string[] {
  const paths = new Set(files.map((f) => f.path));
  const errors: string[] = [];

  for (const f of files) {
    if (!f.path.endsWith('.rs')) continue;
    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = MOD_DECL.exec(lines[i]);
      if (!m) continue;
      // Skip `#[path = "..."] mod x;` — the file location is overridden.
      const prev = (lines[i - 1] || '').trim();
      if (prev.includes('#[path') || lines[i].includes('#[path')) continue;

      const name = m[1];
      const base = moduleBaseDir(f.path);
      const candA = base ? `${base}/${name}.rs` : `${name}.rs`;
      const candB = base ? `${base}/${name}/mod.rs` : `${name}/mod.rs`;
      if (!paths.has(candA) && !paths.has(candB)) {
        errors.push(`${f.path}: \`mod ${name};\` has no matching file (expected ${candA} or ${candB})`);
      }
    }
  }
  return errors;
}

/** True if any .rs file under `srcDir` declares a #[contract] entrypoint. */
function hasContractEntrypoint(files: TreeFile[], srcDir: string): boolean {
  const prefix = srcDir ? `${srcDir}/` : '';
  return files.some(
    (f) => f.path.startsWith(prefix) && f.path.endsWith('.rs') && /#\[\s*contract\s*\]/.test(f.content)
  );
}

/** Resolve a workspace member pattern (possibly a glob) to concrete crate dirs. */
function resolveMemberDirs(member: string, files: TreeFile[]): string[] {
  const manifestDirs = files
    .filter((f) => baseName(f.path) === 'Cargo.toml' && f.path !== 'Cargo.toml')
    .map((f) => dirOfPath(f.path));

  if (member.includes('*')) {
    // Support a trailing "dir/*" glob (the common workspace form).
    const prefix = member.replace(/\*.*$/, '');
    return manifestDirs.filter((d) => d.startsWith(prefix));
  }
  return manifestDirs.filter((d) => d === member);
}

/**
 * Pre-flight validation. `manifestPath` is the project-relative manifest that
 * drives the build (default "Cargo.toml").
 */
export function validateProject(rawFiles: IncomingFile[], manifestPath = DEFAULT_MANIFEST_PATH): LayoutValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let files: TreeFile[];
  try {
    files = normalizeFiles(rawFiles);
  } catch (e: any) {
    return {
      ok: false,
      errors: [`Invalid file path: ${e.message}`],
      warnings: [],
      isWorkspace: false,
      buildDir: '',
      crates: [],
      deployableCrates: []
    };
  }

  const manifest = sanitizeRelPath(manifestPath);
  const buildDir = dirOfPath(manifest);
  const manifestContent = fileAt(files, manifest);

  if (manifestContent === undefined) {
    errors.push(`Manifest not found: ${manifest} (a Cargo.toml is required to build).`);
    return { ok: false, errors, warnings, isWorkspace: false, buildDir, crates: [], deployableCrates: [] };
  }

  const root = parseCargoToml(manifestContent);
  const crates: CrateInfo[] = [];

  if (root.isWorkspace) {
    if (root.workspaceMembers.length === 0) {
      errors.push(`${manifest}: [workspace] has no members.`);
    }
    for (const member of root.workspaceMembers) {
      const dirs = resolveMemberDirs(member, files);
      if (dirs.length === 0) {
        errors.push(`${manifest}: workspace member "${member}" has no Cargo.toml.`);
        continue;
      }
      for (const dir of dirs) {
        const mPath = dir ? `${dir}/Cargo.toml` : 'Cargo.toml';
        const mContent = fileAt(files, mPath);
        if (mContent === undefined) {
          errors.push(`Workspace member manifest missing: ${mPath}`);
          continue;
        }
        const m = parseCargoToml(mContent);
        if (!m.packageName) errors.push(`${mPath}: [package] name is missing.`);
        const srcDir = dir ? `${dir}/src` : 'src';
        crates.push({
          name: m.packageName || dir,
          dir,
          cdylib: m.hasCdylib,
          hasEntrypoint: hasContractEntrypoint(files, srcDir)
        });
      }
    }
  } else {
    if (!root.packageName) errors.push(`${manifest}: [package] name is missing.`);
    const srcDir = buildDir ? `${buildDir}/src` : 'src';
    const hasEntry = hasContractEntrypoint(files, srcDir);
    if (!hasEntry) {
      errors.push(`No #[contract] entrypoint found under ${srcDir}. A deployable contract needs a #[contract] type.`);
    }
    crates.push({
      name: root.packageName || 'contract',
      dir: buildDir,
      cdylib: root.hasCdylib,
      hasEntrypoint: hasEntry
    });
  }

  // Module resolution applies across the whole tree.
  errors.push(...checkModuleResolution(files));

  const deployableCrates = crates.filter((c) => c.cdylib && c.hasEntrypoint);
  if (root.isWorkspace && deployableCrates.length === 0 && errors.length === 0) {
    errors.push('Workspace has no deployable contract crate (need a cdylib crate with a #[contract] entrypoint).');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    isWorkspace: root.isWorkspace,
    buildDir,
    crates,
    deployableCrates
  };
}

// ---------------------------------------------------------------------------
// On-disk materialization (containment-checked)
// ---------------------------------------------------------------------------

/**
 * Write the full tree into `baseDir`, creating intermediate directories. Every
 * write is verified to stay inside `baseDir` (defense-in-depth on top of
 * sanitizeRelPath) so a crafted path can never escape the build sandbox.
 */
export async function materializeTree(baseDir: string, rawFiles: IncomingFile[]): Promise<TreeFile[]> {
  const files = normalizeFiles(rawFiles);
  const baseResolved = path.resolve(baseDir);
  await fs.ensureDir(baseResolved);

  for (const f of files) {
    const safeRel = sanitizeRelPath(f.path);
    const dest = path.resolve(baseResolved, safeRel);
    // Containment: dest must be strictly within baseResolved.
    if (dest !== baseResolved && !dest.startsWith(baseResolved + path.sep)) {
      throw new Error(`Refusing to write outside the build directory: ${f.path}`);
    }
    await fs.ensureDir(path.dirname(dest));
    await fs.writeFile(dest, f.content ?? '');
  }
  return files;
}

// ---------------------------------------------------------------------------
// WASM discovery (path-agnostic, by crate name)
// ---------------------------------------------------------------------------

/** The wasm filename Cargo emits for a crate (hyphens become underscores). */
export function wasmFileForCrate(crateName: string): string {
  return `${crateName.replace(/-/g, '_')}.wasm`;
}

const TARGET_TRIPLES = ['wasm32v1-none', 'wasm32-unknown-unknown'];

export interface FoundWasm {
  fileName: string;
  fullPath: string;
}

/**
 * Find a release wasm under buildDir/target. If `preferCrate` is given, the
 * matching <crate>.wasm is returned first; otherwise the first non-deps wasm.
 */
export async function findWasm(buildDir: string, preferCrate?: string | null): Promise<FoundWasm | null> {
  const wanted = preferCrate ? wasmFileForCrate(preferCrate) : null;
  for (const triple of TARGET_TRIPLES) {
    const dir = path.join(buildDir, 'target', triple, 'release');
    if (!(await fs.pathExists(dir))) continue;
    const entries = (await fs.readdir(dir)).filter((f) => f.endsWith('.wasm') && !f.includes('deps'));
    if (entries.length === 0) continue;
    if (wanted && entries.includes(wanted)) {
      return { fileName: wanted, fullPath: path.join(dir, wanted) };
    }
    // Prefer non-optimized over .optimized.wasm duplicates if present.
    const primary = entries.find((e) => !e.endsWith('.optimized.wasm')) || entries[0];
    return { fileName: primary, fullPath: path.join(dir, primary) };
  }
  return null;
}

/** List every release wasm (one per crate) under buildDir/target. */
export async function listWasms(buildDir: string): Promise<FoundWasm[]> {
  for (const triple of TARGET_TRIPLES) {
    const dir = path.join(buildDir, 'target', triple, 'release');
    if (!(await fs.pathExists(dir))) continue;
    const entries = (await fs.readdir(dir)).filter(
      (f) => f.endsWith('.wasm') && !f.includes('deps') && !f.endsWith('.optimized.wasm')
    );
    if (entries.length > 0) {
      return entries.map((fileName) => ({ fileName, fullPath: path.join(dir, fileName) }));
    }
  }
  return [];
}

export default {
  normalizeFiles,
  parseCargoToml,
  validateProject,
  materializeTree,
  wasmFileForCrate,
  findWasm,
  listWasms
};
