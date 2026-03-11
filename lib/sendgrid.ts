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
  requestData: Request & { loan_number: string }
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const content = `
<p>Your verification request has been successfully submitted.</p>
<p><strong>Request Details:</strong></p>
<ul>
  <li>Account Number: <code>${requestData.loan_number}</code></li>
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

/**
 * Send expert assignment notification
 * Notifies expert when new entities are assigned to them
 */
export async function sendExpertAssignmentNotification(
  expertEmail: string,
  entityNames: string[],
  assignmentCount: number
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const entitiesList = entityNames.map((name) => `<li>${name}</li>`).join('');

  const content = `
<p>You have been assigned <strong>${assignmentCount}</strong> new ${assignmentCount === 1 ? 'entity' : 'entities'} for IRS transcript retrieval.</p>
<p><strong>Assigned Entities:</strong></p>
<ul>
  ${entitiesList}
</ul>
<div class="stats">
  <div class="stat-item">
    <div class="stat-number">24h</div>
    <div class="stat-label">SLA Deadline</div>
  </div>
</div>
<p>Please log in to your Expert Queue to download the signed 8821 forms and begin processing. If you encounter any issues, use the Flag Issue feature to notify the admin team.</p>
  `.trim();

  const html = createEmailTemplate('New Assignment', content, {
    text: 'View My Queue',
    url: `${appUrl}/expert`,
  });

  try {
    await sgMail.send({
      to: expertEmail,
      from: fromEmail,
      subject: `New Assignment: ${assignmentCount} ${assignmentCount === 1 ? 'Entity' : 'Entities'} Ready`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send expert assignment notification:', error);
  }
}

/**
 * Send expert completion notification to admin
 * Notifies admin when expert completes transcript upload
 */
export async function sendExpertCompletionNotification(
  adminEmail: string,
  expertName: string,
  entityName: string,
  requestId: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const content = `
<p>Expert <strong>${expertName}</strong> has completed transcript upload.</p>
<p><strong>Details:</strong></p>
<ul>
  <li>Entity: ${entityName}</li>
  <li>Completed: ${new Date().toLocaleString()}</li>
</ul>
<p>The transcripts are now available in the portal for review.</p>
  `.trim();

  const html = createEmailTemplate('Transcript Upload Complete', content, {
    text: 'Review Transcripts',
    url: `${appUrl}/admin/requests/${requestId}`,
  });

  try {
    await sgMail.send({
      to: adminEmail,
      from: fromEmail,
      subject: `Expert Completed: ${entityName}`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send expert completion notification:', error);
  }
}

/**
 * Send SLA warning to expert
 * Notifies expert when their assignment is approaching the SLA deadline
 */
export async function sendSlaWarningNotification(
  expertEmail: string,
  entityName: string,
  hoursRemaining: number
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const content = `
<p>Your assignment for <strong>${entityName}</strong> has <strong>${Math.round(hoursRemaining)} hours</strong> remaining before the SLA deadline.</p>
<p>Please complete the transcript retrieval or flag any issues preventing completion.</p>
  `.trim();

  const html = createEmailTemplate('SLA Warning', content, {
    text: 'View Assignment',
    url: `${appUrl}/expert`,
  });

  try {
    await sgMail.send({
      to: expertEmail,
      from: fromEmail,
      subject: `SLA Warning: ${entityName} - ${Math.round(hoursRemaining)}h remaining`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send SLA warning notification:', error);
  }
}

/**
 * Send welcome email to newly invited user
 * Includes temporary password for first login
 */
export async function sendWelcomeEmail(
  email: string,
  fullName: string,
  role: string,
  tempPassword: string,
  clientName?: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const roleLabel = role === 'expert' ? 'IRS Expert' : role === 'admin' ? 'Administrator' : role === 'manager' ? 'Manager' : 'Team Member';
  const contextLine = clientName
    ? `<p>You've been added to the <strong>${clientName}</strong> organization as a <strong>${roleLabel}</strong>.</p>`
    : `<p>You've been added to the ModernTax team as a <strong>${roleLabel}</strong>.</p>`;

  const content = `
<p>Welcome to ModernTax, ${fullName}!</p>
${contextLine}
<p>Your account has been created with the following credentials:</p>
<div class="stats">
  <p style="margin: 0;"><strong>Email:</strong> ${email}</p>
  <p style="margin: 8px 0 0 0;"><strong>Temporary Password:</strong> <code style="background: #fff3cd; padding: 2px 8px; border-radius: 4px; font-size: 14px;">${tempPassword}</code></p>
</div>
<p><strong>Important:</strong> Please change your password after your first login and enable Multi-Factor Authentication (MFA) for account security.</p>
  `.trim();

  const html = createEmailTemplate('Welcome to ModernTax', content, {
    text: 'Log In Now',
    url: `${appUrl}/login`,
  });

  try {
    await sgMail.send({
      to: email,
      from: fromEmail,
      subject: 'Welcome to ModernTax Portal — Your Account Is Ready',
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send welcome email:', error);
  }
}

/**
 * Send status change notification to the requesting user
 * Triggered when admin updates a request or entity status
 */
export async function sendStatusChangeNotification(
  email: string,
  requestId: string,
  loanNumber: string,
  oldStatus: string,
  newStatus: string,
  entityName?: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const formatStatus = (s: string) =>
    s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const entityLine = entityName
    ? `<li>Entity: ${entityName}</li>`
    : '';

  const statusMessage: Record<string, string> = {
    '8821_sent': 'Your Form 8821 has been sent for e-signature. Please check your email for a signing request.',
    '8821_signed': 'Your Form 8821 has been signed. We\'re now queuing it for IRS processing.',
    'irs_queue': 'Your request is in the IRS processing queue. Transcripts are typically returned within 24 hours.',
    'processing': 'Your IRS transcripts are being processed and analyzed.',
    'completed': 'Your IRS transcripts are ready for download!',
    'failed': 'There was an issue processing your request. Our team is looking into it.',
  };

  const message = statusMessage[newStatus] || `Your request status has been updated to ${formatStatus(newStatus)}.`;

  const content = `
<p>${message}</p>
<p><strong>Request Details:</strong></p>
<ul>
  <li>Account Number: <code>${loanNumber}</code></li>
  ${entityLine}
  <li>Previous Status: ${formatStatus(oldStatus)}</li>
  <li>New Status: <strong>${formatStatus(newStatus)}</strong></li>
</ul>
<p>Visit your portal dashboard for full details.</p>
  `.trim();

  const html = createEmailTemplate('Request Status Update', content, {
    text: 'View Request',
    url: `${appUrl}/request/${requestId}`,
  });

  try {
    await sgMail.send({
      to: email,
      from: fromEmail,
      subject: `Status Update: ${loanNumber} — ${formatStatus(newStatus)}`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send status change notification:', error);
  }
}

/**
 * Send expert issue notification to admin
 * Triggered when expert flags an issue with an assignment
 */
export async function sendExpertIssueNotification(
  adminEmail: string,
  expertName: string,
  entityName: string,
  issueReason: string,
  notes: string | null,
  requestId: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const content = `
<p>Expert <strong>${expertName}</strong> has flagged an issue with an assignment.</p>
<p><strong>Details:</strong></p>
<ul>
  <li>Entity: ${entityName}</li>
  <li>Issue: <strong>${issueReason}</strong></li>
  ${notes ? `<li>Notes: ${notes}</li>` : ''}
  <li>Reported: ${new Date().toLocaleString()}</li>
</ul>
<p>Please review the assignment and take appropriate action (reassign, contact IRS, etc.).</p>
  `.trim();

  const html = createEmailTemplate('Expert Issue Flagged', content, {
    text: 'Review Assignment',
    url: `${appUrl}/admin/requests/${requestId}`,
  });

  try {
    await sgMail.send({
      to: adminEmail,
      from: fromEmail,
      subject: `[Action Required] Expert Issue: ${entityName} — ${issueReason}`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send expert issue notification:', error);
  }
}

/**
 * Send notification to manager when a team member submits a new request
 */
export async function sendManagerNewRequestNotification(
  managerEmail: string,
  processorName: string,
  loanNumber: string,
  entityCount: number,
  requestId: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const content = `
<p><strong>${processorName}</strong> submitted a new verification request.</p>
<p><strong>Request Details:</strong></p>
<ul>
  <li>Account Number: <code>${loanNumber}</code></li>
  <li>Entities: ${entityCount}</li>
  <li>Submitted: ${new Date().toLocaleString()}</li>
</ul>
<p>You can track the progress of this request in your dashboard.</p>
  `.trim();

  const html = createEmailTemplate('New Team Request', content, {
    text: 'View Request',
    url: `${appUrl}/request/${requestId}`,
  });

  try {
    await sgMail.send({
      to: managerEmail,
      from: fromEmail,
      subject: `New Request: ${loanNumber} by ${processorName}`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send manager notification:', error);
  }
}
