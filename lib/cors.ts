/**
 * Browser origins allowed to call the API.
 *
 * - The production frontends below, plus any listed in CORS_EXTRA_ORIGINS
 *   (comma-separated), matched exactly.
 * - Vercel preview deployments of the web-soroban project. Vercel names them
 *   `web-soroban-<branch-or-hash>-<team-slug>.vercel.app`; the team slug is
 *   unique to the owning Vercel team, so no one else can mint a matching host.
 *   Override the suffix with VERCEL_PREVIEW_SUFFIX if the team changes.
 * - Any localhost port outside production.
 */
export const PRODUCTION_ORIGINS = [
  'https://web-soroban.vercel.app',
  'https://websoroban.in',
  'https://www.websoroban.in',
  'https://pay.websoroban.in',
  'https://payloop.websoroban.in',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const DEFAULT_PREVIEW_SUFFIX = '-harsh-sharmas-projects-edd77f1e.vercel.app';

export function allowedOrigins(): string[] {
  const extra = (process.env.CORS_EXTRA_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
  return [...PRODUCTION_ORIGINS, ...extra];
}

function isVercelPreview(url: URL): boolean {
  const suffix = (process.env.VERCEL_PREVIEW_SUFFIX || DEFAULT_PREVIEW_SUFFIX).toLowerCase();
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || !host.endsWith(suffix)) return false;
  const deployment = host.slice(0, host.length - suffix.length);
  // web-soroban-git-<branch> or web-soroban-<hash>; DNS-label characters only.
  return /^web-soroban-[a-z0-9-]+$/.test(deployment);
}

export function isAllowedOrigin(origin: string | undefined, production = process.env.NODE_ENV === 'production'): boolean {
  if (!origin) return true; // curl, server-to-server, mobile apps
  const normalized = origin.replace(/\/$/, '');
  if (allowedOrigins().includes(normalized)) return true;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return false;
  }
  if (isVercelPreview(url)) return true;
  return !production && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}
