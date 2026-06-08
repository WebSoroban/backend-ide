/**
 * Parse cargo/rustc output into structured diagnostics so the frontend can show
 * errors/warnings inline in the editor gutter instead of one opaque blob.
 *
 * Recognizes the standard rustc shape:
 *   error[E0425]: cannot find value `x` in this scope
 *     --> src/lib.rs:10:5
 */
import type { LogEntry } from './compilationService';

export interface Diagnostic {
  level: 'error' | 'warning';
  code?: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

const HEADER = /^(error|warning)(?:\[([^\]]+)\])?:\s*(.+)$/;
const LOCATION = /-->\s+([^\s:]+):(\d+):(\d+)/;

export function parseDiagnostics(logs: LogEntry[]): Diagnostic[] {
  const lines = logs.map((l) => l.message);
  const diagnostics: Diagnostic[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = HEADER.exec(lines[i].trim());
    if (!m) continue;
    const level = m[1] as 'error' | 'warning';
    const code = m[2] || undefined;
    const message = m[3].trim();

    // Look ahead a few lines for the `--> file:line:col` location.
    const diag: Diagnostic = { level, code, message };
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      const loc = LOCATION.exec(lines[j]);
      if (loc) {
        diag.file = loc[1];
        diag.line = parseInt(loc[2], 10);
        diag.column = parseInt(loc[3], 10);
        break;
      }
    }
    diagnostics.push(diag);
  }

  // De-duplicate identical diagnostics (cargo often repeats the summary).
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.level}|${d.code}|${d.file}|${d.line}|${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export default { parseDiagnostics };
