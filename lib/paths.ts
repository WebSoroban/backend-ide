/**
 * Project-relative path model for multi-file (multi-page) Soroban contracts.
 *
 * Files in the IDE form a TREE, addressed by a POSIX, project-relative `path`
 * (e.g. "src/lib.rs", "src/admin/mod.rs", "tests/integration.rs", "Cargo.toml",
 * ".cargo/config.toml"). This module is the single source of truth for:
 *   - mapping legacy flat file names to tree paths (used by the data backfill),
 *   - sanitizing UNTRUSTED user-supplied paths before they ever touch the disk,
 *   - hashing the whole tree for the build cache.
 *
 * It is intentionally dependency-free (pure string/crypto) so the build workers,
 * the backfill script, the project routes, and the layout validator can all
 * share the exact same rules.
 */
import crypto from 'crypto';

export const DEFAULT_MANIFEST_PATH = 'Cargo.toml';

export interface TreeFile {
  /** Project-relative POSIX path, e.g. "src/lib.rs". */
  path: string;
  content: string;
}

/**
 * Map a LEGACY flat file name to its project-relative tree path, reproducing the
 * implicit layout the build worker used to synthesize at compile time
 * (see realStellarCompilation's single-contract branch, which copied a root
 * `lib.rs` into `src/lib.rs` and injected `[lib] path = "src/lib.rs"`):
 *
 *   - lib.rs                       -> src/lib.rs
 *   - main.rs                      -> src/lib.rs   (worker moved main.rs -> lib.rs)
 *   - test.rs / tests.rs           -> tests/test.rs (integration-test directory)
 *   - <other>.rs                   -> src/<other>.rs
 *   - Cargo.toml                   -> Cargo.toml   (stays at root)
 *   - a name already containing a slash (e.g. ".cargo/config.toml") -> unchanged
 *   - everything else (other .toml, .json, ...) -> unchanged (root)
 *
 * Per-file and deterministic. Collisions (e.g. both lib.rs and main.rs present)
 * are resolved by the caller (the backfill keeps the first and de-dupes the
 * rest) — they do not occur for normal single-file projects.
 */
export function legacyNameToPath(name: string): string {
  const trimmed = (name || '').trim();
  if (!trimmed) return trimmed;

  // Already a path (has a directory segment) — keep as-is. Covers ".cargo/config.toml".
  if (trimmed.includes('/')) return trimmed.replace(/^\.\//, '');

  // The manifest and other root config files stay at the project root.
  if (trimmed === 'Cargo.toml' || trimmed === 'Cargo.lock') return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower.endsWith('.rs')) {
    if (lower === 'lib.rs' || lower === 'main.rs') return 'src/lib.rs';
    if (lower === 'test.rs' || lower === 'tests.rs') return 'tests/test.rs';
    return `src/${trimmed}`;
  }

  // Non-rust, non-manifest root files (e.g. README.md) keep their flat name.
  return trimmed;
}

/** Reserved/dangerous path segments that must never appear. */
const ILLEGAL_SEGMENTS = new Set(['', '.', '..']);

/**
 * Sanitize and normalize an UNTRUSTED, user-supplied project-relative path.
 *
 * Throws on anything that could escape the build directory or is otherwise
 * malformed. On success returns a clean POSIX relative path:
 *   - no leading slash / no absolute paths,
 *   - no "."/".." segments (no traversal),
 *   - no backslashes (Windows separators are rejected, not silently mapped),
 *   - no NUL bytes, no whitespace inside a segment, no empty segments.
 *
 * This mirrors the client-side validation but is the AUTHORITATIVE check — the
 * build workers must call this for every file before writing it to disk.
 */
export function sanitizeRelPath(input: string): string {
  if (typeof input !== 'string') {
    throw new Error('File path must be a string');
  }
  const raw = input.trim();
  if (!raw) throw new Error('File path is empty');
  if (raw.includes('\0')) throw new Error(`File path contains a NUL byte: ${JSON.stringify(input)}`);
  if (raw.includes('\\')) throw new Error(`File path must use "/" separators, not "\\": ${raw}`);
  if (raw.startsWith('/')) throw new Error(`File path must be relative (no leading "/"): ${raw}`);
  // Reject Windows drive letters and URL-ish schemes outright.
  if (/^[a-zA-Z]:/.test(raw) || raw.includes('://')) {
    throw new Error(`File path must be a plain relative path: ${raw}`);
  }

  const segments = raw.split('/');
  for (const seg of segments) {
    if (ILLEGAL_SEGMENTS.has(seg)) {
      throw new Error(`File path has an illegal segment ("${seg}"): ${raw}`);
    }
    if (/\s/.test(seg)) {
      throw new Error(`File path segments may not contain whitespace: ${raw}`);
    }
    if (seg.length > 255) {
      throw new Error(`File path segment is too long: ${raw}`);
    }
  }
  if (segments.length > 32) {
    throw new Error(`File path is too deeply nested: ${raw}`);
  }
  return segments.join('/');
}

/** True if `input` is a safe relative path (does not throw). */
export function isValidRelPath(input: string): boolean {
  try {
    sanitizeRelPath(input);
    return true;
  } catch {
    return false;
  }
}

/** Directory portion of a project-relative path ("" for a root file). */
export function dirOfPath(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

/** Final path segment (the file name). */
export function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

/**
 * Stable hash of an ENTIRE file tree (sorted by path, then path+content).
 * Used as the build-cache key so a change in ANY file busts the cache — not
 * just the entrypoint.
 */
export function hashTree(files: TreeFile[]): string {
  const h = crypto.createHash('sha256');
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    h.update(f.path);
    h.update('\0');
    h.update(f.content ?? '');
    h.update('\0');
  }
  return h.digest('hex');
}

/**
 * Normalize an incoming file record to a { path, content } pair. Accepts both
 * the new shape ({ path }) and the legacy shape ({ name }) so callers can feed
 * either DB rows or API payloads during the transition.
 */
export function toTreeFile(f: { path?: string | null; name?: string | null; content?: string | null }): TreeFile {
  const rawPath = (f.path && f.path.trim()) || legacyNameToPath(f.name || '');
  return { path: sanitizeRelPath(rawPath), content: f.content ?? '' };
}

export default {
  DEFAULT_MANIFEST_PATH,
  legacyNameToPath,
  sanitizeRelPath,
  isValidRelPath,
  dirOfPath,
  baseName,
  hashTree,
  toTreeFile
};
