import type { Request, Response, NextFunction } from 'express';
import { isAdminEmail } from '../lib/admin';

/**
 * Gate admin-only routes. MUST be chained AFTER `authenticate` so `req.user` is
 * populated. Returns 403 for any non-admin (and 401-equivalents are handled by
 * authenticate upstream).
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAdminEmail(req.user?.email)) {
    return res.status(403).json({ success: false, error: 'Admin access required', code: 'ADMIN_ONLY' });
  }
  next();
}

export default { requireAdmin };
