import 'dotenv/config';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import emailService from './emailService';

export interface ReceiptData {
  userEmail: string | null;
  userName?: string | null;
  planName: string;
  planId: string;
  amount: number | string;
  currency: string;
  txHash: string;
  network: string;
  paymentDate: Date;
  subscriptionStart: Date | null;
  subscriptionEnd: Date | null;
}

interface SendResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Receipt service for generating and sending PDF receipts
 */
class ReceiptService {
  receiptsDir: string;

  constructor() {
    this.receiptsDir = path.join(__dirname, '../receipts');
    // Ensure receipts directory exists
    if (!fs.existsSync(this.receiptsDir)) {
      fs.mkdirSync(this.receiptsDir, { recursive: true });
    }
  }

  /**
   * Generate PDF receipt for subscription payment
   * @returns Path to generated PDF file
   */
  async generateReceipt(receiptData: ReceiptData): Promise<string> {
    const {
      userEmail,
      userName,
      planName,
      planId,
      amount,
      currency,
      txHash,
      network,
      paymentDate,
      subscriptionStart,
      subscriptionEnd
    } = receiptData;

    // Generate unique filename
    const timestamp = Date.now();
    const filename = `receipt-${txHash.substring(0, 8)}-${timestamp}.pdf`;
    const filepath = path.join(this.receiptsDir, filename);

    return new Promise<string>((resolve, reject) => {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 50
      });

      const stream = fs.createWriteStream(filepath);
      doc.pipe(stream);

      // Header
      doc.fontSize(24)
         .fillColor('#667eea')
         .text('WebSoroban IDE', { align: 'center' });

      doc.moveDown(0.5);
      doc.fontSize(16)
         .fillColor('#666')
         .text('Payment Receipt', { align: 'center' });

      doc.moveDown(1);

      // Receipt Details Box
      doc.rect(50, doc.y, 495, 200)
         .strokeColor('#e0e0e0')
         .lineWidth(1)
         .stroke();

      // Left column
      const leftX = 70;
      const rightX = 320;
      let currentY = doc.y + 20;

      doc.fontSize(10)
         .fillColor('#999')
         .text('Receipt Number:', leftX, currentY);
      doc.fillColor('#333')
         .text(`REC-${txHash.substring(0, 16).toUpperCase()}`, leftX, currentY + 15, { width: 200 });

      currentY += 50;
      doc.fillColor('#999')
         .text('Payment Date:', leftX, currentY);
      doc.fillColor('#333')
         .text(paymentDate.toLocaleDateString('en-US', {
           year: 'numeric',
           month: 'long',
           day: 'numeric',
           hour: '2-digit',
           minute: '2-digit'
         }), leftX, currentY + 15, { width: 200 });

      currentY += 50;
      doc.fillColor('#999')
         .text('Transaction Hash:', leftX, currentY);
      doc.fontSize(8)
         .fillColor('#333')
         .text(txHash, leftX, currentY + 15, { width: 200 });

      currentY += 50;
      doc.fontSize(10)
         .fillColor('#999')
         .text('Network:', leftX, currentY);
      doc.fillColor('#333')
         .text(network.toUpperCase(), leftX, currentY + 15, { width: 200 });

      // Right column
      currentY = doc.y + 20;
      doc.fontSize(10)
         .fillColor('#999')
         .text('Customer Email:', rightX, currentY);
      doc.fillColor('#333')
         .text(userEmail || '', rightX, currentY + 15, { width: 200 });

      if (userName) {
        currentY += 50;
        doc.fillColor('#999')
           .text('Customer Name:', rightX, currentY);
        doc.fillColor('#333')
           .text(userName, rightX, currentY + 15, { width: 200 });
      }

      currentY += 50;
      doc.fillColor('#999')
         .text('Subscription Plan:', rightX, currentY);
      doc.fontSize(12)
         .fillColor('#667eea')
         .font('Helvetica-Bold')
         .text(planName, rightX, currentY + 15, { width: 200 });

      // Subscription Period
      doc.moveDown(1.5);
      doc.fontSize(10)
         .fillColor('#999')
         .text('Subscription Period:', 70, doc.y);
      doc.fillColor('#333')
         .text(
           `${subscriptionStart!.toLocaleDateString('en-US', {
             year: 'numeric',
             month: 'long',
             day: 'numeric'
           })} - ${subscriptionEnd!.toLocaleDateString('en-US', {
             year: 'numeric',
             month: 'long',
             day: 'numeric'
           })}`,
           70,
           doc.y + 15,
           { width: 475 }
         );

      // Payment Summary
      doc.moveDown(1.5);
      doc.rect(50, doc.y, 495, 100)
         .fillColor('#f8f9fa')
         .fill()
         .strokeColor('#e0e0e0')
         .lineWidth(1)
         .stroke();

      doc.fontSize(14)
         .fillColor('#333')
         .font('Helvetica-Bold')
         .text('Payment Summary', 70, doc.y + 15);

      doc.moveDown(0.5);
      doc.fontSize(11)
         .fillColor('#666')
         .font('Helvetica')
         .text('Subscription Plan:', 70, doc.y, { width: 200 });
      doc.fillColor('#333')
         .font('Helvetica-Bold')
         .text(planName, 280, doc.y, { width: 200 });

      doc.moveDown(0.5);
      doc.font('Helvetica')
         .fillColor('#666')
         .text('Amount:', 70, doc.y, { width: 200 });
      doc.fillColor('#333')
         .font('Helvetica-Bold')
         .text(`${amount} ${currency}`, 280, doc.y, { width: 200 });

      // Total
      doc.moveDown(0.5);
      doc.fontSize(12)
         .fillColor('#667eea')
         .font('Helvetica-Bold')
         .text('Total Paid:', 70, doc.y, { width: 200 });
      doc.fontSize(14)
         .text(`${amount} ${currency}`, 280, doc.y, { width: 200 });

      // Footer
      doc.moveDown(2);
      doc.fontSize(9)
         .fillColor('#999')
         .text('Thank you for your subscription!', { align: 'center' });

      doc.moveDown(0.5);
      doc.text('This is an automated receipt. Please keep this for your records.', { align: 'center' });

      doc.moveDown(1);
      doc.text(`© ${new Date().getFullYear()} WebSoroban IDE. All rights reserved.`, { align: 'center' });

      doc.end();

      stream.on('finish', () => {
        resolve(filepath);
      });

      stream.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Send receipt via email
   */
  async sendReceiptEmail(to: string, pdfPath: string, receiptData: ReceiptData): Promise<SendResult> {
    const { planName, txHash } = receiptData;

    // Route through emailService.deliver — it picks Resend (HTTPS) in production
    // and SMTP locally, and base64-encodes the PDF for the HTTP API.
    const result = await emailService.deliver({
      to,
      subject: `Payment Receipt - ${planName} Subscription - WebSoroban IDE`,
      html: this.generateReceiptEmailTemplate(receiptData),
      text: this.generateReceiptEmailText(receiptData),
      attachments: [
        {
          filename: `receipt-${txHash.substring(0, 8)}.pdf`,
          path: pdfPath,
          contentType: 'application/pdf',
        },
      ],
    });

    if (result.success) {
      console.log(`[ReceiptService] Receipt email sent to ${to}: ${result.messageId || ''}`);
    } else {
      console.error(`[ReceiptService] Failed to send receipt email to ${to}:`, result.error);
    }
    return result;
  }

  /**
   * Generate HTML email template for receipt
   */
  generateReceiptEmailTemplate(receiptData: ReceiptData): string {
    const { planName, amount, currency, txHash, paymentDate, subscriptionEnd } = receiptData;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Receipt - WebSoroban IDE</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 28px;">Payment Receipt</h1>
  </div>

  <div style="background: #ffffff; padding: 40px; border-radius: 0 0 10px 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
    <p style="font-size: 16px; margin-bottom: 20px;">Thank you for your subscription!</p>

    <div style="background: #f8f9fa; border-left: 4px solid #667eea; padding: 20px; margin: 20px 0;">
      <p style="margin: 0 0 10px 0; font-size: 14px; color: #666;">Plan</p>
      <p style="margin: 0; font-size: 20px; font-weight: bold; color: #667eea;">${planName}</p>
    </div>

    <table style="width: 100%; margin: 20px 0; border-collapse: collapse;">
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #eee; color: #666;">Amount</td>
        <td style="padding: 10px 0; border-bottom: 1px solid #eee; text-align: right; font-weight: bold;">${amount} ${currency}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #eee; color: #666;">Transaction Hash</td>
        <td style="padding: 10px 0; border-bottom: 1px solid #eee; text-align: right; font-family: monospace; font-size: 12px;">${txHash.substring(0, 16)}...</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; border-bottom: 1px solid #eee; color: #666;">Payment Date</td>
        <td style="padding: 10px 0; border-bottom: 1px solid #eee; text-align: right;">${paymentDate.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })}</td>
      </tr>
      <tr>
        <td style="padding: 10px 0; color: #666;">Subscription Valid Until</td>
        <td style="padding: 10px 0; text-align: right; font-weight: bold;">${subscriptionEnd!.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        })}</td>
      </tr>
    </table>

    <div style="background: #e8f5e9; border: 1px solid #4caf50; border-radius: 6px; padding: 15px; margin: 20px 0;">
      <p style="margin: 0; color: #2e7d32; font-weight: bold;">✓ Your subscription is now active!</p>
    </div>

    <p style="font-size: 14px; color: #666; margin-top: 30px;">
      A PDF receipt has been attached to this email for your records.
    </p>

    <p style="font-size: 14px; color: #666; margin-top: 20px; padding-top: 20px; border-top: 1px solid #eee;">
      If you have any questions about this receipt, please contact our support team.
    </p>
  </div>

  <div style="text-align: center; margin-top: 20px; padding: 20px; color: #999; font-size: 12px;">
    <p style="margin: 0;">© ${new Date().getFullYear()} WebSoroban IDE. All rights reserved.</p>
  </div>
</body>
</html>
    `.trim();
  }

  /**
   * Generate plain text email template for receipt
   */
  generateReceiptEmailText(receiptData: ReceiptData): string {
    const { planName, amount, currency, txHash, paymentDate, subscriptionEnd } = receiptData;

    return `
Payment Receipt - WebSoroban IDE

Thank you for your subscription!

Plan: ${planName}
Amount: ${amount} ${currency}
Transaction Hash: ${txHash}
Payment Date: ${paymentDate.toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric'
})}
Subscription Valid Until: ${subscriptionEnd!.toLocaleDateString('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric'
})}

✓ Your subscription is now active!

A PDF receipt has been attached to this email for your records.

If you have any questions about this receipt, please contact our support team.

© ${new Date().getFullYear()} WebSoroban IDE. All rights reserved.
    `.trim();
  }
}

export default new ReceiptService();
