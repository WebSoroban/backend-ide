/**
 * Observability — structured logging + optional Sentry error capture.
 *
 * Logs are emitted as single-line JSON so a log pipeline (Railway, Datadog, etc.)
 * can parse them. Sentry is OPTIONAL: it activates only when SENTRY_DSN is set
 * AND `@sentry/node` is installed (loaded via a guarded require so it is never a
 * hard dependency). With neither, captureError still logs the error — nothing is
 * silently swallowed.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = LEVELS[(process.env.LOG_LEVEL as Level)] ?? LEVELS.info;

let sentry: any = null;

function emit(level: Level, msg: string, meta?: Record<string, any>) {
  if (LEVELS[level] < MIN) return;
  const line = JSON.stringify({ level, ts: new Date().toISOString(), msg, ...(meta || {}) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, any>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, any>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, any>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, any>) => emit('error', msg, meta),
};

/**
 * Initialize Sentry if configured. Safe to call once at process start (API and
 * each worker). Returns whether Sentry is active.
 */
export function initObservability(): { sentry: boolean } {
  const dsn = process.env.SENTRY_DSN;
  if (dsn && !sentry) {
    try {
      // Indirect require so TS doesn't try to resolve the (optional) module type
      // and the bundler doesn't hard-link it.
      const mod = '@sentry/node';
      sentry = require(mod);
      sentry.init({
        dsn,
        environment: process.env.NODE_ENV || 'development',
        tracesSampleRate: 0,
        release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
      });
      logger.info('Sentry error monitoring enabled');
    } catch (e: any) {
      sentry = null;
      logger.warn('SENTRY_DSN set but @sentry/node is not installed; error monitoring disabled', {
        hint: 'npm i @sentry/node',
      });
    }
  }
  return { sentry: !!sentry };
}

/** Log an error (structured) and forward to Sentry when enabled. Never throws. */
export function captureError(err: unknown, context?: Record<string, any>) {
  const e = err instanceof Error ? err : new Error(String(err));
  emit('error', e.message, { ...context, stack: e.stack });
  if (sentry) {
    try {
      sentry.captureException(e, context ? { extra: context } : undefined);
    } catch {
      /* logging must never throw */
    }
  }
}

export default { logger, captureError, initObservability };
