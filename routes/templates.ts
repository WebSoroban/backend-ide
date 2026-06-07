import express, { type Request, type Response } from 'express';
import crypto from 'crypto';
import prisma from '../lib/prisma';
import { authenticate, optionalAuth } from '../middleware/auth';
import {
  TEMPLATE_CATALOG,
  getTemplateById,
  getPublicTemplateDocs,
  FREE_TEMPLATE_IDS
} from '../data/templateCatalog';

const router = express.Router();

/**
 * GET /api/templates
 * List templates available to the caller. Public: free only. Authenticated: free + purchased.
 */
router.get('/', optionalAuth, async (req: Request, res: Response) => {
  try {
    const allowedIds = req.user
      ? [...FREE_TEMPLATE_IDS, ...(req.user.purchasedTemplates || [])]
      : FREE_TEMPLATE_IDS;
    const allowedSet = new Set(allowedIds);
    const templates = TEMPLATE_CATALOG.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category,
      files: t.files,
      price: t.price,
      hasAccess: allowedSet.has(t.id)
    }));
    res.json(templates);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

/**
 * GET /api/templates/marketplace
 * Public: list all templates with full documentation (for marketplace & docs).
 */
router.get('/marketplace', (req: Request, res: Response) => {
  try {
    res.json({ success: true, templates: getPublicTemplateDocs() });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch marketplace templates' });
  }
});

/**
 * GET /api/templates/marketplace/:id
 * Public: single template documentation by id.
 */
router.get('/marketplace/:id', (req: Request, res: Response) => {
  try {
    const template = getTemplateById(req.params.id);
    if (!template) {
      return res.status(404).json({ success: false, error: 'Template not found' });
    }
    res.json({
      success: true,
      template: {
        id: template.id,
        name: template.name,
        description: template.description,
        category: template.category,
        files: template.files,
        price: template.price,
        documentation: template.documentation
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch template' });
  }
});

/**
 * POST /api/templates/purchase
 * Create a template purchase intent. Same payment gateway as plans (XLM to PAYMENT_ADDRESS).
 * Returns payment details (address, amount, memo) and purchaseId for verification.
 */
router.post('/purchase', authenticate, async (req: Request, res: Response) => {
  try {
    const { templateId } = req.body;
    const user = req.user!;

    if (!templateId) {
      return res.status(400).json({ success: false, error: 'templateId is required' });
    }

    const template = getTemplateById(templateId);
    if (!template) {
      return res.status(400).json({ success: false, error: 'Invalid template' });
    }
    if (template.price === 0) {
      return res.status(400).json({ success: false, error: 'Template is free; no purchase needed' });
    }

    const alreadyOwned = (user.purchasedTemplates || []).includes(templateId);
    if (alreadyOwned) {
      return res.status(400).json({ success: false, error: 'You already own this template' });
    }

    const paymentAddress = process.env.PAYMENT_ADDRESS || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
    const network = process.env.PAYMENT_NETWORK || 'testnet';

    const memo = crypto.randomUUID();

    const expiresAt = new Date();
    expiresAt.setMinutes(expiresAt.getMinutes() + 30);

    const purchase = await prisma.templatePurchase.create({
      data: {
        userId: user.id,
        templateId,
        amount: template.price,
        currency: 'XLM',
        status: 'pending',
        memo,
        network,
        expiresAt
      }
    });

    res.json({
      success: true,
      purchaseId: purchase.id,
      template: {
        id: template.id,
        name: template.name,
        price: template.price,
        currency: 'XLM'
      },
      payment: {
        address: paymentAddress,
        amount: template.price,
        currency: 'XLM',
        memo: purchase.memo,
        network
      },
      message: `Send ${template.price} XLM to ${paymentAddress} with memo: ${purchase.memo}`
    });
  } catch (error: any) {
    console.error('Create template purchase error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create purchase',
      message: error.message
    });
  }
});

/**
 * GET /api/templates/my-purchases
 * List template IDs the current user has purchased (for UI).
 */
router.get('/my-purchases', authenticate, (req: Request, res: Response) => {
  try {
    const purchased = req.user!.purchasedTemplates || [];
    res.json({ success: true, templateIds: purchased });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch purchases' });
  }
});

export default router;
