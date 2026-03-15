require('dotenv').config();
const nodemailer = require('nodemailer');

/**
 * Email service for sending invite codes
 */
class EmailService {
  constructor() {
    this.transporter = null;
    this.initialize();
  }

  /**
   * Initialize nodemailer transporter
   */
  initialize() {
    const emailConfig = {
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      }
    };

    // Only create transporter if credentials are provided
    if (emailConfig.auth.user && emailConfig.auth.pass) {
      this.transporter = nodemailer.createTransport(emailConfig);
      
      // Verify connection
      this.transporter.verify((error, success) => {
        if (error) {
          console.error('[EmailService] SMTP connection error:', error);
        } else {
          console.log('[EmailService] SMTP server is ready to send emails');
        }
      });
    } else {
      console.warn('[EmailService] SMTP credentials not configured. Email sending disabled.');
    }
  }

  /**
   * Generate HTML email template for invite code
   */
  generateInviteEmailTemplate(inviteCode, appName = 'WebSoroban IDE') {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Invite Code - ${appName}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">Welcome to ${appName}!</h1>
  </div>
  
  <div style="background: #ffffff; padding: 40px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
    <p style="font-size: 16px; margin-bottom: 20px;">Hello,</p>
    
    <p style="font-size: 16px; margin-bottom: 20px;">
      You've been invited to join <strong>${appName}</strong>! We're excited to have you on board.
    </p>
    
    <div style="background: #f8f9fa; border: 2px dashed #667eea; border-radius: 8px; padding: 30px; text-align: center; margin: 30px 0;">
      <p style="margin: 0 0 10px 0; font-size: 14px; color: #666; text-transform: uppercase; letter-spacing: 1px;">Your Invite Code</p>
      <p style="margin: 0; font-size: 32px; font-weight: bold; color: #667eea; letter-spacing: 3px; font-family: 'Courier New', monospace;">${inviteCode}</p>
    </div>
    
    <p style="font-size: 16px; margin-bottom: 20px;">
      To get started:
    </p>
    
    <ol style="font-size: 16px; margin-bottom: 30px; padding-left: 20px;">
      <li style="margin-bottom: 10px;">Log in to your account</li>
      <li style="margin-bottom: 10px;">Click on the invite code button</li>
      <li style="margin-bottom: 10px;">Enter the code above when prompted</li>
      <li style="margin-bottom: 10px;">Start building amazing Soroban smart contracts!</li>
    </ol>
    
    <div style="text-align: center; margin-top: 30px;">
      <a href="${process.env.FRONTEND_URL || 'https://websoroban.in'}" 
         style="display: inline-block; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
        Get Started
      </a>
    </div>
    
    <p style="font-size: 14px; color: #666; margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee;">
      If you didn't request this invite, you can safely ignore this email.
    </p>
  </div>
  
  <div style="text-align: center; margin-top: 20px; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">© ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Generate plain text email template for invite code
   */
  generateInviteEmailText(inviteCode, appName = 'WebSoroban IDE') {
    return `
Welcome to ${appName}!

You've been invited to join ${appName}! We're excited to have you on board.

Your Invite Code: ${inviteCode}

To get started:
1. Log in to your account
2. Click on the invite code button
3. Enter the code above when prompted
4. Start building amazing Soroban smart contracts!

Visit: ${process.env.FRONTEND_URL || 'https://websoroban.in'}

If you didn't request this invite, you can safely ignore this email.

© ${new Date().getFullYear()} ${appName}. All rights reserved.
    `.trim();
  }

  /**
   * Send invite code email
   * @param {string} to - Recipient email address
   * @param {string} inviteCode - Invite code to send
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Send result
   */
  async sendInviteCode(to, inviteCode, options = {}) {

    if (!this.transporter) {
      console.log('[EmailService] Transporter not initialized, attempting to initialize...');
      this.initialize();
      
      // Check again after initialization
      if (!this.transporter) {
        const missingConfig = [];
        if (!process.env.SMTP_USER) missingConfig.push('SMTP_USER');
        if (!process.env.SMTP_PASSWORD) missingConfig.push('SMTP_PASSWORD');
        
        const errorMsg = missingConfig.length > 0
          ? `Email service not configured. Missing: ${missingConfig.join(', ')}`
          : 'Email service not configured. Please check SMTP settings.';
        
        console.warn(`[EmailService] ${errorMsg}`);
        console.warn(`[EmailService] SMTP_USER: ${process.env.SMTP_USER ? 'SET' : 'NOT SET'}`);
        console.warn(`[EmailService] SMTP_PASSWORD: ${process.env.SMTP_PASSWORD ? 'SET' : 'NOT SET'}`);
        return {
          success: false,
          error: errorMsg
        };
      }
    }

    const appName = options.appName || 'WebSoroban IDE';
    const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
    const fromName = process.env.SMTP_FROM_NAME || appName;

    if (!fromEmail) {
      const errorMsg = 'SMTP_FROM or SMTP_USER environment variable is required';
      console.error(`[EmailService] ${errorMsg}`);
      return {
        success: false,
        error: errorMsg
      };
    }

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: to,
      subject: options.subject || `Your Invite Code for ${appName}`,
      text: this.generateInviteEmailText(inviteCode, appName),
      html: this.generateInviteEmailTemplate(inviteCode, appName)
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log(`[EmailService] Invite code email sent to ${to}:`, info.messageId);
      return {
        success: true,
        messageId: info.messageId
      };
    } catch (error) {
      console.error(`[EmailService] Failed to send email to ${to}:`, error);
      
      // Provide more specific error messages
      let errorMessage = error.message;
      if (error.code === 'EAUTH') {
        errorMessage = 'SMTP authentication failed. Please check your SMTP_USER and SMTP_PASSWORD.';
      } else if (error.code === 'ECONNECTION') {
        errorMessage = `Cannot connect to SMTP server (${process.env.SMTP_HOST || 'smtp.gmail.com'}:${process.env.SMTP_PORT || '587'}). Please check SMTP_HOST and SMTP_PORT.`;
      } else if (error.code === 'ETIMEDOUT') {
        errorMessage = 'SMTP connection timed out. Please check your network connection and SMTP settings.';
      }
      
      return {
        success: false,
        error: errorMessage,
        errorCode: error.code
      };
    }
  }

  /**
   * Send bulk invite codes
   * @param {Array} invites - Array of {email, inviteCode} objects
   * @returns {Promise<Object>} Send results
   */
  async sendBulkInviteCodes(invites) {
    const results = {
      success: [],
      failed: []
    };

    for (const invite of invites) {
      const result = await this.sendInviteCode(invite.email, invite.inviteCode);
      if (result.success) {
        results.success.push(invite.email);
      } else {
        results.failed.push({
          email: invite.email,
          error: result.error
        });
      }
      
      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return results;
  }

  /**
   * Generate HTML email template for premium gift notification
   */
  generatePremiumGiftEmailTemplate(email, durationDays, isNewUser, endDate, appName = 'WebSoroban IDE') {
    const endDateFormatted = endDate ? new Date(endDate).toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    }) : 'Never expires';
    
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Premium Subscription Gifted - ${appName}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">🎁 Premium Subscription Gifted!</h1>
  </div>
  
  <div style="background: #ffffff; padding: 40px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
    <p style="font-size: 16px; margin-bottom: 20px;">Hello,</p>
    
    <p style="font-size: 16px; margin-bottom: 20px;">
      ${isNewUser 
        ? `Congratulations! You've been gifted a <strong>Premium Subscription</strong> to <strong>${appName}</strong>!` 
        : `Great news! Your account has been upgraded to a <strong>Premium Subscription</strong> on <strong>${appName}</strong>!`}
    </p>
    
    <div style="background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border: 2px solid #fbbf24; border-radius: 8px; padding: 30px; text-align: center; margin: 30px 0;">
      <div style="font-size: 48px; margin-bottom: 10px;">👑</div>
      <p style="margin: 0 0 10px 0; font-size: 14px; color: #92400e; text-transform: uppercase; letter-spacing: 1px; font-weight: bold;">Premium Plan</p>
      <p style="margin: 0; font-size: 24px; font-weight: bold; color: #92400e;">Unlimited Everything!</p>
    </div>
    
    <div style="background: #f8f9fa; border-radius: 8px; padding: 20px; margin: 30px 0;">
      <h3 style="margin-top: 0; color: #333; font-size: 18px;">Your Premium Benefits:</h3>
      <ul style="font-size: 16px; margin: 0; padding-left: 20px; color: #555;">
        <li style="margin-bottom: 10px;">✅ <strong>Unlimited</strong> contract compilations</li>
        <li style="margin-bottom: 10px;">✅ <strong>Unlimited</strong> contract deployments</li>
        <li style="margin-bottom: 10px;">✅ <strong>Unlimited</strong> function testing calls</li>
        <li style="margin-bottom: 10px;">✅ Priority support</li>
        <li style="margin-bottom: 10px;">✅ Access to all premium features</li>
      </ul>
    </div>
    
    <div style="background: #eff6ff; border-left: 4px solid #3b82f6; padding: 15px; margin: 30px 0; border-radius: 4px;">
      <p style="margin: 0; font-size: 14px; color: #1e40af;">
        <strong>Subscription Details:</strong><br>
        Duration: ${durationDays} day${durationDays !== 1 ? 's' : ''}<br>
        ${endDate ? `Valid until: ${endDateFormatted}` : 'Lifetime subscription'}
      </p>
    </div>
    
    ${isNewUser ? `
    <p style="font-size: 16px; margin-bottom: 20px;">
      To get started, simply sign in with your Google account using this email address:
    </p>
    <div style="background: #f3f4f6; padding: 15px; border-radius: 6px; margin: 20px 0;">
      <p style="margin: 0; font-size: 14px; color: #6b7280; font-family: monospace;">${email}</p>
    </div>
    ` : ''}
    
    <div style="text-align: center; margin-top: 30px;">
      <a href="${process.env.FRONTEND_URL || 'https://websoroban.in'}/ide" 
         style="display: inline-block; background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%); color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
        Start Building Now
      </a>
    </div>
    
    <p style="font-size: 14px; color: #666; margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee;">
      If you have any questions or need assistance, please don't hesitate to contact our support team.
    </p>
  </div>
  
  <div style="text-align: center; margin-top: 20px; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">© ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Generate plain text email template for premium gift notification
   */
  generatePremiumGiftEmailText(email, durationDays, isNewUser, endDate, appName = 'WebSoroban IDE') {
    const endDateFormatted = endDate ? new Date(endDate).toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    }) : 'Never expires';
    
    return `
🎁 Premium Subscription Gifted!

Hello,

${isNewUser 
  ? `Congratulations! You've been gifted a Premium Subscription to ${appName}!` 
  : `Great news! Your account has been upgraded to a Premium Subscription on ${appName}!`}

Your Premium Benefits:
✅ Unlimited contract compilations
✅ Unlimited contract deployments
✅ Unlimited function testing calls
✅ Priority support
✅ Access to all premium features

Subscription Details:
Duration: ${durationDays} day${durationDays !== 1 ? 's' : ''}
${endDate ? `Valid until: ${endDateFormatted}` : 'Lifetime subscription'}

${isNewUser ? `To get started, simply sign in with your Google account using this email address: ${email}` : ''}

Visit: ${process.env.FRONTEND_URL || 'https://websoroban.in'}/ide

If you have any questions or need assistance, please don't hesitate to contact our support team.

© ${new Date().getFullYear()} ${appName}. All rights reserved.
    `.trim();
  }

  /**
   * Generate HTML email template for template purchase confirmation
   */
  generateTemplatePurchaseEmailTemplate(userName, templateName, amount, currency, txHash, appName = 'WebSoroban IDE') {
    const frontendUrl = process.env.FRONTEND_URL || 'https://websoroban.in';
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Template Purchased - ${appName}</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">✓ Template Purchased</h1>
  </div>
  
  <div style="background: #ffffff; padding: 40px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
    <p style="font-size: 16px; margin-bottom: 20px;">Hello${userName ? ` ${userName}` : ''},</p>
    
    <p style="font-size: 16px; margin-bottom: 20px;">
      Your purchase of the <strong>${templateName}</strong> template was successful. You can now use it in the IDE.
    </p>
    
    <div style="background: #f0f9ff; border: 2px solid #3b82f6; border-radius: 8px; padding: 24px; margin: 30px 0;">
      <p style="margin: 0 0 8px 0; font-size: 14px; color: #1e40af; text-transform: uppercase; letter-spacing: 1px;">Purchase details</p>
      <p style="margin: 0 0 4px 0; font-size: 18px; font-weight: bold; color: #1e3a8a;">${templateName}</p>
      <p style="margin: 0 0 4px 0; font-size: 16px; color: #334155;">Amount: ${amount} ${currency}</p>
      <p style="margin: 0; font-size: 12px; color: #64748b; font-family: monospace; word-break: break-all;">Tx: ${txHash || 'N/A'}</p>
    </div>
    
    <div style="text-align: center; margin-top: 30px;">
      <a href="${frontendUrl}/ide" 
         style="display: inline-block; background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: white; padding: 14px 30px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px;">
        Open IDE & use template
      </a>
    </div>
    
    <p style="font-size: 14px; color: #666; margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee;">
      Create a new project and choose "${templateName}" from the template list to get started.
    </p>
  </div>
  
  <div style="text-align: center; margin-top: 20px; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">© ${new Date().getFullYear()} ${appName}. All rights reserved.</p>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Generate plain text email for template purchase confirmation
   */
  generateTemplatePurchaseEmailText(userName, templateName, amount, currency, txHash, appName = 'WebSoroban IDE') {
    const frontendUrl = process.env.FRONTEND_URL || 'https://websoroban.in';
    return `
Template Purchased - ${appName}

Hello${userName ? ` ${userName}` : ''},

Your purchase of the ${templateName} template was successful. You can now use it in the IDE.

Purchase details:
- Template: ${templateName}
- Amount: ${amount} ${currency}
- Transaction: ${txHash || 'N/A'}

Open the IDE: ${frontendUrl}/ide

Create a new project and choose "${templateName}" from the template list to get started.

© ${new Date().getFullYear()} ${appName}. All rights reserved.
    `.trim();
  }

  /**
   * Send template purchase confirmation email
   * @param {string} to - Recipient email
   * @param {string} templateName - Name of the template purchased
   * @param {number} amount - Amount paid
   * @param {string} currency - Currency (e.g. XLM)
   * @param {string} txHash - Transaction hash
   * @param {Object} options - { userName, appName, subject }
   */
  async sendTemplatePurchaseNotification(to, templateName, amount, currency, txHash, options = {}) {
    if (!this.transporter) {
      this.initialize();
      if (!this.transporter) {
        console.warn('[EmailService] SMTP not configured, skipping template purchase email');
        return { success: false, error: 'Email not configured' };
      }
    }

    const appName = options.appName || 'WebSoroban IDE';
    const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
    const fromName = process.env.SMTP_FROM_NAME || appName;
    if (!fromEmail) {
      console.warn('[EmailService] SMTP_FROM/SMTP_USER not set, skipping template purchase email');
      return { success: false, error: 'From email not set' };
    }

    const userName = options.userName || null;
    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: to,
      subject: options.subject || `✓ Template purchased: ${templateName} - ${appName}`,
      text: this.generateTemplatePurchaseEmailText(userName, templateName, amount, currency, txHash, appName),
      html: this.generateTemplatePurchaseEmailTemplate(userName, templateName, amount, currency, txHash, appName)
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log(`[EmailService] Template purchase confirmation sent to ${to}:`, info.messageId);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('[EmailService] Failed to send template purchase email:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send premium gift notification email
   * @param {string} to - Recipient email address
   * @param {number} durationDays - Duration of the premium subscription in days
   * @param {boolean} isNewUser - Whether this is a new user
   * @param {Date|string} endDate - End date of the subscription
   * @param {Object} options - Additional options
   * @returns {Promise<Object>} Send result
   */
  async sendPremiumGiftNotification(to, durationDays, isNewUser, endDate, options = {}) {
    if (!this.transporter) {
      console.log('[EmailService] Transporter not initialized, attempting to initialize...');
      this.initialize();
      
      if (!this.transporter) {
        const missingConfig = [];
        if (!process.env.SMTP_USER) missingConfig.push('SMTP_USER');
        if (!process.env.SMTP_PASSWORD) missingConfig.push('SMTP_PASSWORD');
        
        const errorMsg = missingConfig.length > 0
          ? `Email service not configured. Missing: ${missingConfig.join(', ')}`
          : 'Email service not configured. Please check SMTP settings.';
        
        console.warn(`[EmailService] ${errorMsg}`);
        return {
          success: false,
          error: errorMsg
        };
      }
    }

    const appName = options.appName || 'WebSoroban IDE';
    const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
    const fromName = process.env.SMTP_FROM_NAME || appName;

    if (!fromEmail) {
      const errorMsg = 'SMTP_FROM or SMTP_USER environment variable is required';
      console.error(`[EmailService] ${errorMsg}`);
      return {
        success: false,
        error: errorMsg
      };
    }

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: to,
      subject: options.subject || `🎁 Premium Subscription Gifted - ${appName}`,
      text: this.generatePremiumGiftEmailText(to, durationDays, isNewUser, endDate, appName),
      html: this.generatePremiumGiftEmailTemplate(to, durationDays, isNewUser, endDate, appName)
    };

    try {
      const info = await this.transporter.sendMail(mailOptions);
      console.log(`[EmailService] Premium gift notification sent to ${to}:`, info.messageId);
      return {
        success: true,
        messageId: info.messageId
      };
    } catch (error) {
      console.error(`[EmailService] Failed to send premium gift email to ${to}:`, error);
      
      let errorMessage = error.message;
      if (error.code === 'EAUTH') {
        errorMessage = 'SMTP authentication failed. Please check your SMTP_USER and SMTP_PASSWORD.';
      } else if (error.code === 'ECONNECTION') {
        errorMessage = `Cannot connect to SMTP server (${process.env.SMTP_HOST || 'smtp.gmail.com'}:${process.env.SMTP_PORT || '587'}). Please check SMTP_HOST and SMTP_PORT.`;
      } else if (error.code === 'ETIMEDOUT') {
        errorMessage = 'SMTP connection timed out. Please check your network connection and SMTP settings.';
      }
      
      return {
        success: false,
        error: errorMessage,
        errorCode: error.code
      };
    }
  }
}

module.exports = new EmailService();

