/**
 * SendGrid Email Utilities
 * Handles all email notifications for ModernTax portal
 */

import sgMail from '@sendgrid/mail';
import type { Request, RequestEntity, DailyNudgeStats } from './types';

// Initialize SendGrid
const sendGridApiKey = process.env.SENDGRID_API_KEY;
const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'notifications@moderntax.io';

if (!sendGridApiKey) {
  console.warn('SENDGRID_API_KEY not configured - email sending will not work');
} else {
  sgMail.setApiKey(sendGridApiKey);
}

const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

/**
 * HTML Email Template Wrapper
 * ModernTax branded email template with dark background and green accents
 */
function createEmailTemplate(
  title: string,
  content: string,
  cta?: { text: string; url: string }
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      line-height: 1.6;
      color: #333;
      background-color: #f5f5f5;
      margin: 0;
      padding: 0;
    }
    .container {
      max-width: 600px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
    }
    .header {
      background: linear-gradient(135deg, #0A1929 0%, #102A43 100%);
      color: #ffffff;
      padding: 40px 20px;
      text-align: center;
      border-bottom: 4px solid #00C48C;
    }
    .header h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
      letter-spacing: -0.5px;
    }
    .header .logo {
      font-weight: 700;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 12px;
      opacity: 0.8;
    }
    .body {
      padding: 40px;
      color: #1a1a1a;
    }
    .body p {
      margin: 0 0 16px 0;
      font-size: 15px;
      line-height: 1.8;
    }
    .cta-button {
      display: inline-block;
      background-color: #00C48C;
      color: #ffffff;
      padding: 14px 32px;
      border-radius: 6px;
      text-decoration: none;
      font-weight: 600;
      margin-top: 24px;
      transition: background-color 0.2s;
    }
    .cta-button:hover {
      background-color: #00a870;
    }
    .stats {
      background-color: #f9f9f9;
      border-left: 4px solid #00C48C;
      padding: 16px;
      margin: 24px 0;
      border-radius: 4px;
    }
    .stat-item {
      display: inline-block;
      margin-right: 32px;
      margin-bottom: 8px;
    }
    .stat-number {
      font-size: 24px;
      font-weight: 700;
      color: #00C48C;
    }
    .stat-label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .footer {
      background-color: #f9f9f9;
      border-top: 1px solid #e0e0e0;
      padding: 24px 40px;
      text-align: center;
      font-size: 12px;
      color: #666;
    }
    .footer a {
      color: #00C48C;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">ModernTax</div>
      <h1>${title}</h1>
    </div>
    <div class="body">
      ${content}
      ${
        cta
          ? `<a href="${cta.url}" class="cta-button">${cta.text}</a>`
          : ''
      }
    </div>
    <div class="footer">
      <p>ModernTax Portal | IRS Transcript Verification</p>
      <p><a href="${appUrl}">Visit Portal</a> | <a href="https://moderntax.io">Learn More</a></p>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Send request confirmation email
 * Triggered when user submits a new verification request
 */
export async function sendRequestConfirmation(
  email: string,
  requestData: Request & { account_number: string }
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const content = `
<p>Your verification request has been successfully submitted.</p>
<p><strong>Request Details:</strong></p>
<ul>
  <li>Account Number: <code>${requestData.account_number}</code></li>
  <li>Request ID: <code>${requestData.id}</code></li>
  <li>Submitted: ${new Date(requestData.created_at).toLocaleDateString()}</li>
</ul>
<p>Our team will process your request and you'll receive updates as we progress. Check your portal dashboard for real-time status updates.</p>
  `.trim();

  const html = createEmailTemplate('Request Confirmed', content, {
    text: 'View Request',
    url: `${appUrl}/requests/${requestData.id}`,
  });

  try {
    await sgMail.send({
      to: email,
      from: fromEmail,
      subject: 'Your Verification Request Has Been Submitted',
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send request confirmation email:', error);
    throw error;
  }
}

/**
 * Send completion notification email
 * Triggered when transcripts are ready for download
 */
export async function sendCompletionNotification(
  email: string,
  requestData: Request,
  entities: RequestEntity[]
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const entitiesList = entities
    .map(
      (e) =>
        `<li>${e.entity_name} (${e.form_type}) - Compliance Score: <strong>${e.compliance_score || 'N/A'}%</strong></li>`
    )
    .join('');

  const content = `
<p>Great news! Your IRS transcripts are ready for review.</p>
<p><strong>Completed Entities:</strong></p>
<ul>
  ${entitiesList}
</ul>
<p>You can now download the transcripts and review the detailed compliance information in your portal. All documents are securely stored and available for future reference.</p>
<p><strong>Next Steps:</strong></p>
<ol>
  <li>Review the transcript details and compliance scores</li>
  <li>Download all supporting documents</li>
  <li>Use this information for your lending decision</li>
</ol>
  `.trim();

  const html = createEmailTemplate('Transcripts Ready', content, {
    text: 'View Transcripts',
    url: `${appUrl}/requests/${requestData.id}`,
  });

  try {
    await sgMail.send({
      to: email,
      from: fromEmail,
      subject: 'Your IRS Transcripts Are Ready',
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send completion notification email:', error);
    throw error;
  }
}

/**
 * Send daily nudge email
 * Daily summary of pending/completed requests for users
 */
export async function sendDailyNudge(email: string, stats: DailyNudgeStats): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const oldestDaysText =
    stats.oldest_pending_days !== null
      ? `Your oldest pending request is ${stats.oldest_pending_days} days old.`
      : '';

  const content = `
<p>Here's your daily activity summary for the ModernTax Portal:</p>
<div class="stats">
  <div class="stat-item">
    <div class="stat-number">${stats.pending_count}</div>
    <div class="stat-label">Pending</div>
  </div>
  <div class="stat-item">
    <div class="stat-number">${stats.in_progress_count}</div>
    <div class="stat-label">In Progress</div>
  </div>
  <div class="stat-item">
    <div class="stat-number">${stats.completed_count}</div>
    <div class="stat-label">Completed Today</div>
  </div>
</div>
<p>${oldestDaysText}</p>
<p>Visit your dashboard to submit new verification requests, track existing ones, or download completed transcripts.</p>
  `.trim();

  const html = createEmailTemplate('Daily Activity Summary', content, {
    text: 'View Dashboard',
    url: `${appUrl}/dashboard`,
  });

  try {
    await sgMail.send({
      to: email,
      from: fromEmail,
      subject: 'ModernTax Daily Summary',
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send daily nudge email:', error);
    throw error;
  }
}

/**
 * Send admin notification for failed requests
 * Alerts admin when a request fails processing
 */
export async function sendAdminFailureAlert(
  adminEmail: string,
  requestId: string,
  reason: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const content = `
<p>A verification request has failed processing.</p>
<p><strong>Request Details:</strong></p>
<ul>
  <li>Request ID: <code>${requestId}</code></li>
  <li>Reason: ${reason}</li>
  <li>Time: ${new Date().toLocaleString()}</li>
</ul>
<p>Please investigate and follow up with the client if necessary.</p>
  `.trim();

  const html = createEmailTemplate('Request Processing Failed', content, {
    text: 'View Request',
    url: `${appUrl}/admin/requests/${requestId}`,
  });

  try {
    await sgMail.send({
      to: adminEmail,
      from: fromEmail,
      subject: `[Alert] Verification Request Failed - ${requestId}`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send admin failure alert:', error);
    throw error;
  }
}
