const prisma = require('../lib/prisma');
const { verifyToken } = require('../utils/auth');

/**
 * Authentication middleware
 * Verifies JWT token and attaches user to request
 */
async function authenticate(req, res, next) {
  try {
    // Get token from Authorization header or cookie
    const token = req.headers.authorization?.replace('Bearer ', '') ||
                  req.cookies?.token ||
                  req.query?.token;

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        message: 'Please log in to access this resource'
      });
    }

    // Verify token
    const decoded = verifyToken(token);
    if (!decoded) {
      return res.status(401).json({
        success: false,
        error: 'Invalid token',
        message: 'Your session has expired. Please log in again.'
      });
    }

    // Get user from database
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        error: 'User not found or inactive',
        message: 'Your account is not active. Please contact support.'
      });
    }

    // Attach user to request
    req.user = user;
    req.userId = user.id;

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(500).json({
      success: false,
      error: 'Authentication failed',
      message: error.message
    });
  }
}

/**
 * Optional authentication middleware
 * Attaches user if token is present, but doesn't require it
 */
async function optionalAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '') ||
                  req.cookies?.token ||
                  req.query?.token;

    if (token) {
      const decoded = verifyToken(token);
      if (decoded) {
        const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
        if (user && user.isActive) {
          req.user = user;
          req.userId = user.id;
        }
      }
    }

    next();
  } catch (error) {
    // Continue without authentication if error occurs
    next();
  }
}

module.exports = {
  authenticate,
  optionalAuth
};
