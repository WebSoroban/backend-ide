import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import passport from 'passport';
import prisma from './lib/prisma';
import socketService from './services/socketService';

import authRoutes from './routes/auth';
import projectsRoutes from './routes/projects';
import compileRoutes from './routes/compile';
import deployRoutes from './routes/deploy';
import testRoutes from './routes/test';
import templatesRoutes from './routes/templates';
import jobsRoutes from './routes/jobs';
import subscriptionsRoutes from './routes/subscriptions';
import premiumGiftsRoutes from './routes/premium-gifts';
import paymentsRoutes from './routes/payments';
import usageRoutes from './routes/usage';
import contractsRoutes from './routes/contracts';
import walletRoutes from './routes/wallet';
import userTemplatesRoutes from './routes/userTemplates';
import aiRoutes from './routes/ai';
import skillsRoutes from './routes/skills';
import billingRoutes from './routes/billing';
import dodoWebhookRoutes from './routes/webhooks/dodo';
import payRoutes from './routes/pay';
import { allowedOrigins as corsAllowedOrigins, isAllowedOrigin } from './lib/cors';
import payloopRoutes from './routes/payloop';
import { startWebhookDispatcher } from './services/x402Webhooks';
import { initObservability, captureError, logger } from './lib/observability';

// Initialize error monitoring (Sentry if SENTRY_DSN + @sentry/node present).
initObservability();

// Boot marker — if this prints, all module imports (incl. the Stellar CLI check
// in deploymentService) resolved without hanging.
console.log('[boot] modules loaded, initializing server...');

const app = express();
const server = http.createServer(app);

// Allowed frontend origins (hardcoded)
const allowedOrigins = corsAllowedOrigins();

// CORS validation function
const corsOptions: cors.CorsOptions = {
  // Disallowed origins get no CORS headers (the browser blocks them) rather
  // than a 500 for every request.
  origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // x402 browser clients retry the request with PAYMENT-SIGNATURE after the
  // wallet approves. Keep X-PAYMENT for v1/backwards-compatible clients.
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-API-KEY",
    "PAYMENT-SIGNATURE",
    "X-PAYMENT",
    // @x402/fetch currently adds this response-oriented header to its paid
    // retry request. Accept it so stock browser clients can complete CORS.
    "Access-Control-Expose-Headers",
  ],
  exposedHeaders: [
    "Content-Type",
    "PAYMENT-REQUIRED",
    "PAYMENT-RESPONSE",
    "PAYMENT-ERROR",
    "X-PAYMENT-RESPONSE",
  ]
};

// Socket.IO setup with CORS
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, isAllowedOrigin(origin)),
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Make io available globally for workers
global.io = io;

// Initialize socket service
socketService.init(io);

// Request logging middleware (for debugging)
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`[Request] ${req.method} ${req.path} - Origin: ${req.headers.origin || 'none'}`);
  next();
});

// Middleware - CORS configuration
app.use(cors(corsOptions));
app.use(cookieParser());
// Dodo webhook needs the RAW body for Standard Webhooks signature verification —
// mount it with a raw parser BEFORE express.json() (which would otherwise consume
// and re-serialize the body, breaking the HMAC).
app.use('/api/webhooks/dodo', express.raw({ type: '*/*' }), dodoWebhookRoutes);
app.use(express.json());
app.use(passport.initialize());

// Health check endpoint
app.get('/api/health', async (req: Request, res: Response) => {
  let database = 'disconnected';
  try {
    await prisma.$queryRaw`SELECT 1`;
    database = 'connected';
  } catch (_) {
    database = 'disconnected';
  }
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    database
  });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/compile', compileRoutes);
app.use('/api/deploy', deployRoutes);
app.use('/api/test', testRoutes);
app.use('/api/templates', templatesRoutes);
app.use('/api/jobs', jobsRoutes);
// Commented out invite system - replaced with premium gifting
// app.use('/api/invites', invitesRoutes);
app.use('/api/subscriptions', subscriptionsRoutes);
app.use('/api/premium-gifts', premiumGiftsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/usage', usageRoutes);
app.use('/api/contracts', contractsRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/user-templates', userTemplatesRoutes);
// Skills mounts under /api/ai/skills — register BEFORE the generic /api/ai router.
app.use('/api/ai/skills', skillsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/pay', payRoutes);
app.use('/api/payloop', payloopRoutes);

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`[Socket.IO] Client connected: ${socket.id}`);

  // Handle job subscription
  socket.on('subscribe:job', (jobId: string) => {
    console.log(`[Socket.IO] Client ${socket.id} subscribed to job: ${jobId}`);
    socket.join(`job:${jobId}`);
  });

  // Handle job unsubscription
  socket.on('unsubscribe:job', (jobId: string) => {
    console.log(`[Socket.IO] Client ${socket.id} unsubscribed from job: ${jobId}`);
    socket.leave(`job:${jobId}`);
  });

  // AI Copilot run streaming — join/leave the per-run room.
  socket.on('subscribe:run', (runId: string) => {
    socket.join(`run:${runId}`);
  });
  socket.on('unsubscribe:run', (runId: string) => {
    socket.leave(`run:${runId}`);
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
  });
});

// Error handling middleware (must be after routes)
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  const status = err.status || 500;
  // Capture server errors (5xx) to the monitor; 4xx are client faults, just log.
  if (status >= 500) {
    captureError(err, { path: req.path, method: req.method, userId: (req as any).userId });
  } else {
    logger.warn(err.message || 'request error', { path: req.path, method: req.method, status });
  }
  res.status(status).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

// 404 handler for API routes
app.use('/api/*', (req: Request, res: Response) => {
  console.log(`[404] Route not found: ${req.method} ${req.path}`);
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`
  });
});

const PORT = Number(process.env.PORT) || 3001;
// Bind explicitly on 0.0.0.0 so Railway's healthcheck can reach the container
// over IPv4 (a bare listen can bind IPv6-only on some hosts).
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Socket.IO server initialized`);
  console.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
  console.log(`Database: Neon Postgres (Prisma)`);
  console.log(`Available routes:`);
  console.log(`  - GET  /api/health`);
  console.log(`  - GET  /api/wallet/me`);
  console.log(`  - POST /api/wallet/ensure`);
  console.log(`  - POST /api/wallet/fund`);

  // Verify Socket.IO is working
  console.log(`Socket.IO namespace: ${(io as any).name}`);
  console.log(`Socket.IO engine: ${(io.engine as any)?.constructor?.name || 'unknown'}`);

  // Pay webhooks retry from Postgres, so any API instance resumes pending deliveries.
  startWebhookDispatcher();
});

// Last-resort process guards so a stray async error is captured (and reported to
// the monitor) instead of crashing silently or taking the process down.
process.on('unhandledRejection', (reason) => {
  captureError(reason, { scope: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  captureError(err, { scope: 'uncaughtException' });
});
