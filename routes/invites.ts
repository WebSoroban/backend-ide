/*
 * INVITE SYSTEM - DISABLED
 *
 * This entire invite system has been replaced with premium gifting functionality.
 * The new system allows gifting premium subscriptions directly to users via email.
 * See /api/premium-gifts routes for the new implementation.
 *
 * The original Mongoose-based invite implementation (send / check / validate /
 * list / send-bulk / generate-bulk) was already commented out in the JavaScript
 * source and depended on a `../models/Invite` Mongoose model that no longer
 * exists. It has therefore not been carried over to TypeScript. Refer to git
 * history for the previous implementation if needed.
 */

import express, { type Request, type Response } from 'express';

const router = express.Router();

// All invite routes are disabled - use /api/premium-gifts instead
router.use((req: Request, res: Response) => {
  res.status(410).json({
    success: false,
    error: 'Invite system has been disabled. Please use the premium gifting system at /api/premium-gifts instead.'
  });
});

export default router;
