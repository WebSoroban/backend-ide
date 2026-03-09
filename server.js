const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const passport = require('passport');
const mongoose = require('mongoose');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Allowed frontend origins (hardcoded)
const allowedOrigins = [
  "https://web-soroban.vercel.app",
  "https://websoroban.in",
  "https://www.websoroban.in",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
];

// CORS validation function
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      console.log('[CORS] Request with no origin - allowing');
      return callback(null, true);
    }
    
    console.log(`[CORS] Request from origin: ${origin}`);
    
    // Normalize origin (remove trailing slash, www, etc.)
    const normalizedOrigin = origin.replace(/\/$/, ''); // Remove trailing slash
    
    // Check if origin is in allowed list (exact match or normalized)
    if (allowedOrigins.includes(origin) || allowedOrigins.includes(normalizedOrigin)) {
      console.log(`[CORS] Origin allowed: ${origin}`);
      return callback(null, true);
    }
    // In development, allow any localhost / 127.0.0.1 origin (different ports)
    if (process.env.NODE_ENV !== 'production') {
      try {
        const u = new URL(origin);
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
          console.log(`[CORS] Origin allowed (dev): ${origin}`);
          return callback(null, true);
        }
      } catch (_) {}
    }
    console.log(`[CORS] Origin NOT allowed: ${origin}`);
    console.log(`[CORS] Allowed origins: ${allowedOrigins.join(', ')}`);
    callback(new Error(`Not allowed by CORS. Origin: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-API-KEY"],
  exposedHeaders: ["Content-Type"]
};

// Socket.IO setup with CORS
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Make io available globally for workers
global.io = io;

// Initialize socket service
const socketService = require('./services/socketService');
socketService.init(io);

// Request logging middleware (for debugging)
app.use((req, res, next) => {
  console.log(`[Request] ${req.method} ${req.path} - Origin: ${req.headers.origin || 'none'}`);
  next();
});

// Middleware - CORS configuration
app.use(cors(corsOptions));
app.use(cookieParser());
app.use(express.json());
app.use(passport.initialize());

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/soroban-ide';
mongoose.connect(MONGODB_URI);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/compile', require('./routes/compile'));
app.use('/api/deploy', require('./routes/deploy'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/jobs', require('./routes/jobs'));
// Commented out invite system - replaced with premium gifting
// app.use('/api/invites', require('./routes/invites'));
app.use('/api/subscriptions', require('./routes/subscriptions'));
app.use('/api/premium-gifts', require('./routes/premium-gifts'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/usage', require('./routes/usage'));
app.use('/api/contracts', require('./routes/contracts'));

// Phase 1: Developer infrastructure
app.use('/api/apikeys', require('./routes/apikeys'));
app.use('/api/rpc', require('./routes/rpc'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/transactions', require('./routes/transactions'));
app.use('/api/webhooks', require('./routes/webhooks'));

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`[Socket.IO] Client connected: ${socket.id}`);
  
  // Handle job subscription
  socket.on('subscribe:job', (jobId) => {
    console.log(`[Socket.IO] Client ${socket.id} subscribed to job: ${jobId}`);
    socket.join(`job:${jobId}`);
  });
  
  // Handle job unsubscription
  socket.on('unsubscribe:job', (jobId) => {
    console.log(`[Socket.IO] Client ${socket.id} unsubscribed from job: ${jobId}`);
    socket.leave(`job:${jobId}`);
  });
  
  socket.on('disconnect', () => {
    console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
  });
});

// Error handling middleware (must be after routes)
app.use((err, req, res, next) => {
  console.error('[Error]', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

// 404 handler for API routes
app.use('/api/*', (req, res) => {
  console.log(`[404] Route not found: ${req.method} ${req.path}`);
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.path}`
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Socket.IO server initialized`);
  console.log(`CORS allowed origins: ${allowedOrigins.join(', ')}`);
  console.log(`MongoDB URI: ${MONGODB_URI}`);
  console.log(`Available routes:`);
  console.log(`  - GET  /api/health`);
  console.log(`  - POST /api/invites/check`);
  console.log(`  - POST /api/invites/validate`);
  console.log(`  - POST /api/invites/send`);
  console.log(`  - GET  /api/invites`);
  
  // Verify Socket.IO is working
  console.log(`Socket.IO namespace: ${io.name}`);
  console.log(`Socket.IO engine: ${io.engine?.constructor?.name || 'unknown'}`);
}); 