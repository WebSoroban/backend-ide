const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  walletAddress: {
    type: String,
    default: null,
    sparse: true // Allows multiple nulls
  },
  authMethod: {
    type: String,
    enum: ['gmail', 'wallet', 'both'],
    default: 'gmail'
  },
  googleId: {
    type: String,
    default: null,
    sparse: true
  },
  passwordHash: {
    type: String,
    default: null
  },
  name: {
    type: String,
    default: ''
  },
  picture: {
    type: String,
    default: null
  },
  subscription: {
    plan: {
      type: String,
      enum: ['free', 'plan2', 'plan3'],
      default: 'free'
    },
    status: {
      type: String,
      enum: ['active', 'cancelled', 'expired'],
      default: 'active'
    },
    startDate: {
      type: Date,
      default: Date.now
    },
    endDate: {
      type: Date,
      default: null
    },
    paymentTxHash: {
      type: String,
      default: null
    },
    autoRenew: {
      type: Boolean,
      default: false
    }
  },
  usage: {
    deployments: {
      count: {
        type: Number,
        default: 0
      },
      limit: {
        type: Number,
        default: 5 // Free plan default
      },
      lastResetDate: {
        type: Date,
        default: Date.now
      }
    },
    functionTests: {
      count: {
        type: Number,
        default: 0
      },
      limit: {
        type: Number,
        default: 2 // Free plan default
      },
      lastResetDate: {
        type: Date,
        default: Date.now
      }
    }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date,
    default: Date.now
  },
  purchasedTemplates: {
    type: [String],
    default: []
  }
}, {
  timestamps: true
});

// Indexes for faster queries (email already has unique index, so we skip it)
userSchema.index({ walletAddress: 1 }, { sparse: true });
userSchema.index({ googleId: 1 }, { sparse: true });
userSchema.index({ 'subscription.plan': 1, 'subscription.status': 1 });

// Method to update subscription plan
userSchema.methods.updateSubscription = function(plan, paymentTxHash = null) {
  this.subscription.plan = plan;
  this.subscription.status = 'active';
  this.subscription.startDate = new Date();
  
  // Set end date based on plan (30 days for paid plans)
  if (plan !== 'free') {
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 30);
    this.subscription.endDate = endDate;
  } else {
    this.subscription.endDate = null;
  }
  
  if (paymentTxHash) {
    this.subscription.paymentTxHash = paymentTxHash;
  }
  
  // Update usage limits based on plan (without saving, we'll save at the end)
  this.updateUsageLimits(plan, false);
  
  return this.save();
};

// Method to update usage limits based on plan (without saving)
userSchema.methods.updateUsageLimits = function(plan, save = false) {
  switch (plan) {
    case 'free':
      this.usage.deployments.limit = 5;
      this.usage.functionTests.limit = 2;
      break;
    case 'plan2':
      this.usage.deployments.limit = -1; // -1 means unlimited
      this.usage.functionTests.limit = 5;
      break;
    case 'plan3':
      this.usage.deployments.limit = -1; // -1 means unlimited
      this.usage.functionTests.limit = -1; // -1 means unlimited
      break;
  }
  if (save) {
    return this.save();
  }
  return this;
};

// Method to check if deployment is allowed
userSchema.methods.canDeploy = function() {
  if (this.usage.deployments.limit === -1) {
    return { allowed: true };
  }
  
  // Check if monthly reset is needed
  const now = new Date();
  const resetDate = new Date(this.usage.deployments.lastResetDate);
  const daysSinceReset = Math.floor((now - resetDate) / (1000 * 60 * 60 * 24));
  
  if (daysSinceReset >= 30) {
    // Reset monthly usage
    this.usage.deployments.count = 0;
    this.usage.deployments.lastResetDate = now;
    this.usage.functionTests.count = 0;
    this.usage.functionTests.lastResetDate = now;
    this.save();
  }
  
  if (this.usage.deployments.count >= this.usage.deployments.limit) {
    return {
      allowed: false,
      reason: 'Deployment limit reached',
      current: this.usage.deployments.count,
      limit: this.usage.deployments.limit
    };
  }
  
  return { allowed: true, current: this.usage.deployments.count, limit: this.usage.deployments.limit };
};

// Method to check if function test is allowed
userSchema.methods.canTestFunction = function() {
  if (this.usage.functionTests.limit === -1) {
    return { allowed: true };
  }
  
  // Check if monthly reset is needed
  const now = new Date();
  const resetDate = new Date(this.usage.functionTests.lastResetDate);
  const daysSinceReset = Math.floor((now - resetDate) / (1000 * 60 * 60 * 24));
  
  if (daysSinceReset >= 30) {
    // Reset monthly usage
    this.usage.functionTests.count = 0;
    this.usage.functionTests.lastResetDate = now;
    this.usage.deployments.count = 0;
    this.usage.deployments.lastResetDate = now;
    this.save();
  }
  
  if (this.usage.functionTests.count >= this.usage.functionTests.limit) {
    return {
      allowed: false,
      reason: 'Function test limit reached',
      current: this.usage.functionTests.count,
      limit: this.usage.functionTests.limit
    };
  }
  
  return { allowed: true, current: this.usage.functionTests.count, limit: this.usage.functionTests.limit };
};

// Method to increment deployment count
userSchema.methods.incrementDeployment = function() {
  this.usage.deployments.count += 1;
  return this.save();
};

// Method to increment function test count
userSchema.methods.incrementFunctionTest = function() {
  this.usage.functionTests.count += 1;
  return this.save();
};

module.exports = mongoose.model('User', userSchema);
