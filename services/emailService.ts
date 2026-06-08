import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import nodemailer, { type Transporter } from 'nodemailer';

interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
  errorCode?: string;
}

interface EmailOptions {
  appName?: string;
  subject?: string;
  userName?: string | null;
}

interface MailAttachment {
  filename: string;
  /** Raw content (Buffer or string). Provide this or `path`. */
  content?: Buffer | string;
  /** Path to a file on disk to attach (read + base64-encoded for the HTTP API). */
  path?: string;
  contentType?: string;
}

interface DeliverOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: MailAttachment[];
}

/**
 * Email service for sending invite codes
 */
class EmailService {
  transporter: Transporter | null;

  constructor() {
    this.transporter = null;
    this.initialize();
  }

  /**
   * Initialize nodemailer transporter
   */
  initialize() {
    // EMAIL SENDING IS PAUSED (see deliver()). Don't open any SMTP connection —
    // this avoids the boot-time connection-verify timeouts. Re-enable by
    // removing this early return along with the switch in deliver().
    this.transporter = null;
    return;

    /* eslint-disable no-unreachable -- kept for when email is re-enabled
    // When the Resend HTTP API is configured we send over HTTPS (port 443) and
    // never touch SMTP — which is blocked outbound on Railway. Skip the SMTP
    // transporter entirely so its connection-verify doesn't spam ETIMEDOUT.
    if (process.env.RESEND_API_KEY) {
      this.transporter = null;
      console.log('[EmailService] Resend HTTP API configured — using it for delivery (SMTP disabled).');
      return;
    }

    const host = process.env.SMTP_HOST || 'smtp.gmail.com';
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    // Port 465 is implicit TLS; 587/25 use STARTTLS. Honour SMTP_SECURE when
    // set, otherwise derive it from the port so a 465 host can't be opened in
    // plaintext mode (which silently hangs).
    const secure = process.env.SMTP_SECURE
      ? process.env.SMTP_SECURE === 'true'
      : port === 465;

    const emailConfig = {
      host,
      port,
      secure,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      },
      // Railway/Render/Fly outbound IPv6 to Gmail's SMTP is frequently
      // unrouteable; Node tries the AAAA record first and hangs until timeout
      // (the ETIMEDOUT on CONN seen only in production). Force IPv4.
      family: 4,
      // Fail fast instead of hanging on nodemailer's ~2-minute defaults.
      connectionTimeout: 10_000, // TCP connect
      greetingTimeout: 10_000,   // SMTP greeting
      socketTimeout: 20_000,     // socket inactivity
      // Reuse a small connection pool across the background email sends.
      pool: true,
      maxConnections: 2,
      maxMessages: 50
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
    */
  }

  /**
   * Single delivery entrypoint for every email. Routes over the Resend HTTPS
   * API when configured (the only path that works on Railway, where SMTP ports
   * are blocked), and falls back to SMTP for local development.
   */
  async deliver({ to, subject, html, text, attachments }: DeliverOptions): Promise<SendResult> {
    // ───────────────────────────────────────────────────────────────────────
    // EMAIL SENDING IS PAUSED.
    // Every outgoing email (invite codes, template-purchase, premium gift,
    // receipts) routes through deliver(), so this one switch disables all of
    // them. To re-enable, delete this block — the implementation below is intact.
    // ───────────────────────────────────────────────────────────────────────
    console.log(`[EmailService] Email paused — skipped "${subject}" to ${to}`);
    return { success: false, error: 'Email sending is disabled' };
    /* eslint-disable no-unreachable -- implementation kept for when email is re-enabled
    const appName = 'WebSoroban IDE';
    const fromEmail = process.env.SMTP_FROM || process.env.SMTP_USER;
    const fromName = process.env.SMTP_FROM_NAME || appName;
    if (!fromEmail) {
      const errorMsg = 'SMTP_FROM or SMTP_USER environment variable is required';
      console.error(`[EmailService] ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
    const from = `"${fromName}" <${fromEmail}>`;

    // Prefer the HTTPS API — it works where outbound SMTP is blocked.
    if (process.env.RESEND_API_KEY) {
      return this.sendViaResend(from, { to, subject, html, text, attachments });
    }

    // SMTP fallback (local dev / hosts that allow outbound SMTP).
    if (!this.transporter) {
      this.initialize();
      if (!this.transporter) {
        const missing: string[] = [];
        if (!process.env.SMTP_USER) missing.push('SMTP_USER');
        if (!process.env.SMTP_PASSWORD) missing.push('SMTP_PASSWORD');
        const errorMsg = missing.length
          ? `Email not configured. Missing: ${missing.join(', ')} (or set RESEND_API_KEY).`
          : 'Email not configured. Set RESEND_API_KEY or SMTP credentials.';
        console.warn(`[EmailService] ${errorMsg}`);
        return { success: false, error: errorMsg };
      }
    }

    try {
      const info = await this.transporter.sendMail({ from, to, subject, html, text, attachments });
      return { success: true, messageId: info.messageId };
    } catch (error: any) {
      let errorMessage = error.message;
      if (error.code === 'EAUTH') errorMessage = 'SMTP authentication failed. Check SMTP_USER and SMTP_PASSWORD.';
      else if (error.code === 'ECONNECTION') errorMessage = `Cannot connect to SMTP server (${process.env.SMTP_HOST || 'smtp.gmail.com'}:${process.env.SMTP_PORT || '587'}).`;
      else if (error.code === 'ETIMEDOUT') errorMessage = 'SMTP connection timed out (SMTP ports are blocked on Railway — set RESEND_API_KEY).';
      console.error(`[EmailService] SMTP send failed to ${to}:`, errorMessage);
      return { success: false, error: errorMessage, errorCode: error.code };
    }
    */
  }

  /**
   * Send a message through the Resend HTTP API over HTTPS.
   * @see https://resend.com/docs/api-reference/emails/send-email
   */
  private async sendViaResend(from: string, { to, subject, html, text, attachments }: DeliverOptions): Promise<SendResult> {
    try {
      let resendAttachments: Array<{ filename: string; content: string }> | undefined;
      if (attachments?.length) {
        resendAttachments = await Promise.all(
          attachments.map(async (a) => {
            const buf = a.content
              ? Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content)
              : a.path ? await readFile(a.path) : Buffer.alloc(0);
            return { filename: a.filename, content: buf.toString('base64') };
          }),
        );
      }

      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject,
          html,
          text,
          ...(resendAttachments ? { attachments: resendAttachments } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const errorMsg = `Resend API error (${response.status}): ${body || response.statusText}`;
        console.error(`[EmailService] ${errorMsg}`);
        return { success: false, error: errorMsg, errorCode: String(response.status) };
      }

      const data: any = await response.json().catch(() => ({}));
      console.log(`[EmailService] Email sent via Resend to ${to}: ${data?.id || ''}`);
      return { success: true, messageId: data?.id };
    } catch (error: any) {
      console.error(`[EmailService] Resend send failed to ${to}:`, error?.message || error);
      return { success: false, error: error?.message || 'Resend send failed', errorCode: error?.code };
    }
  }

  /**
   * Generate HTML email template for invite code
   */
  generateInviteEmailTemplate(inviteCode: string, appName = 'WebSoroban IDE'): string {
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
  generateInviteEmailText(inviteCode: string, appName = 'WebSoroban IDE'): string {
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
   */
  async sendInviteCode(to: string, inviteCode: string, options: EmailOptions = {}): Promise<SendResult> {
    const appName = options.appName || 'WebSoroban IDE';
    const result = await this.deliver({
      to,
      subject: options.subject || `Your Invite Code for ${appName}`,
      text: this.generateInviteEmailText(inviteCode, appName),
      html: this.generateInviteEmailTemplate(inviteCode, appName),
    });
    if (result.success) console.log(`[EmailService] Invite code email sent to ${to}: ${result.messageId || ''}`);
    return result;
  }

  /**
   * Send bulk invite codes
   */
  async sendBulkInviteCodes(
    invites: Array<{ email: string; inviteCode: string }>
  ): Promise<{ success: string[]; failed: Array<{ email: string; error?: string }> }> {
    const results: { success: string[]; failed: Array<{ email: string; error?: string }> } = {
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
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    return results;
  }

  /**
   * Generate HTML email template for premium gift notification
   */
  generatePremiumGiftEmailTemplate(
    email: string,
    durationDays: number,
    isNewUser: boolean,
    endDate: Date | string | null,
    appName = 'WebSoroban IDE'
  ): string {
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
  generatePremiumGiftEmailText(
    email: string,
    durationDays: number,
    isNewUser: boolean,
    endDate: Date | string | null,
    appName = 'WebSoroban IDE'
  ): string {
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
  generateTemplatePurchaseEmailTemplate(
    userName: string | null,
    templateName: string,
    amount: number | string,
    currency: string,
    txHash: string,
    appName = 'WebSoroban IDE'
  ): string {
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
  generateTemplatePurchaseEmailText(
    userName: string | null,
    templateName: string,
    amount: number | string,
    currency: string,
    txHash: string,
    appName = 'WebSoroban IDE'
  ): string {
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
   */
  async sendTemplatePurchaseNotification(
    to: string,
    templateName: string,
    amount: number | string,
    currency: string,
    txHash: string,
    options: EmailOptions = {}
  ): Promise<SendResult> {
    const appName = options.appName || 'WebSoroban IDE';
    const userName = options.userName || null;
    const result = await this.deliver({
      to,
      subject: options.subject || `✓ Template purchased: ${templateName} - ${appName}`,
      text: this.generateTemplatePurchaseEmailText(userName, templateName, amount, currency, txHash, appName),
      html: this.generateTemplatePurchaseEmailTemplate(userName, templateName, amount, currency, txHash, appName),
    });
    if (result.success) console.log(`[EmailService] Template purchase confirmation sent to ${to}: ${result.messageId || ''}`);
    return result;
  }

  /**
   * Send premium gift notification email
   */
  async sendPremiumGiftNotification(
    to: string,
    durationDays: number,
    isNewUser: boolean,
    endDate: Date | string | null,
    options: EmailOptions = {}
  ): Promise<SendResult> {
    const appName = options.appName || 'WebSoroban IDE';
    const result = await this.deliver({
      to,
      subject: options.subject || `🎁 Premium Subscription Gifted - ${appName}`,
      text: this.generatePremiumGiftEmailText(to, durationDays, isNewUser, endDate, appName),
      html: this.generatePremiumGiftEmailTemplate(to, durationDays, isNewUser, endDate, appName),
    });
    if (result.success) console.log(`[EmailService] Premium gift notification sent to ${to}: ${result.messageId || ''}`);
    return result;
  }
}

export default new EmailService();
