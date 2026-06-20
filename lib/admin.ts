/**
 * Admin allowlist.
 *
 * Admins are defined by the ADMIN_EMAILS env var (comma-separated, matched
 * case-insensitively against the authenticated user's email). No schema/role
 * column is needed; flipping admin access is an env change + restart.
 */
export function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().includes(email.toLowerCase());
}

export default { adminEmails, isAdminEmail };
