/**
 * SendGrid Email Utilities
 * Handles all email notifications for ModernTax portal
 */

import sgMail from '@sendgrid/mail';
import type { Request, RequestEntity, DailyNudgeStats, AdminDailySummaryStats, ManagerWeeklySummaryStats } from './types';

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
 * Send password reset email
 * Triggered when user requests a password reset via /forgot-password
 */
export async function sendPasswordResetEmail(
  email: string,
  name: string,
  resetLink: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const content = `
<p>Hi ${name},</p>
<p>We received a request to reset your password for the ModernTax Portal. Click the button below to set a new password:</p>
<p style="font-size: 13px; color: #666; margin-top: 24px;"><strong>This link will expire in 24 hours.</strong> If you didn't request a password reset, you can safely ignore this email — your password will remain unchanged.</p>
  `.trim();

  const html = createEmailTemplate('Password Reset', content, {
    text: 'Reset My Password',
    url: resetLink,
  });

  try {
    await sgMail.send({
      to: email,
      from: fromEmail,
      subject: 'Reset Your ModernTax Password',
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send password reset email:', error);
    throw error;
  }
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
  assignmentCount: number,
  isEmployment?: boolean
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const entitiesList = entityNames.map((name) => `<li>${name}</li>`).join('');

  const taskDescription = isEmployment
    ? 'Wage & Income transcript retrieval'
    : 'IRS transcript retrieval';

  const instructions = isEmployment
    ? 'Please log in to your Expert Queue to pull Wage & Income transcripts from IRS and begin processing. If you encounter any issues, use the Flag Issue feature to notify the admin team.'
    : 'Please log in to your Expert Queue to download the signed 8821 forms and begin processing. If you encounter any issues, use the Flag Issue feature to notify the admin team.';

  const content = `
<p>You have been assigned <strong>${assignmentCount}</strong> new ${assignmentCount === 1 ? 'entity' : 'entities'} for ${taskDescription}.</p>
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
<p>${instructions}</p>
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
  clientName?: string,
  _resetLink?: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const roleLabel = role === 'expert' ? 'IRS Expert' : role === 'admin' ? 'Administrator' : role === 'manager' ? 'Manager' : 'Team Member';
  const contextLine = clientName
    ? `<p>You've been added to the <strong>${clientName}</strong> organization as a <strong>${roleLabel}</strong>.</p>`
    : `<p>You've been added to the ModernTax team as a <strong>${roleLabel}</strong>.</p>`;

  // Always include temp password — recovery links expire too quickly and
  // email scanners/link previewers often consume the single-use token before
  // the user even opens the email, causing "Invalid or expired link" errors.
  const credentialsBlock = `
<div class="stats">
  <p style="margin: 0;"><strong>Email:</strong> ${email}</p>
  <p style="margin: 8px 0 0 0;"><strong>Temporary Password:</strong> <code style="background: #fff3cd; padding: 2px 8px; border-radius: 4px; font-size: 14px;">${tempPassword}</code></p>
</div>
<p>Use these credentials to log in. You can change your password after logging in via <strong>Settings</strong>.</p>
  `;

  const content = `
<p>Welcome to ModernTax, ${fullName}!</p>
${contextLine}
<p>Your account has been created.</p>
${credentialsBlock}
  `.trim();

  const html = createEmailTemplate('Welcome to ModernTax', content, {
    text: 'Log In Now',
    url: `${appUrl}/login`,
  });

  try {
    await sgMail.send({
      to: email,
      from: fromEmail,
      subject: 'Welcome to ModernTax — Set Up Your Account',
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send welcome email:', error);
    throw error; // Re-throw so caller can handle/report
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
<p>Click below to review the request details and 8821 form information.</p>
  `.trim();

  const html = createEmailTemplate('New Team Request', content, {
    text: 'Review Request',
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

/**
 * Send admin notification when a new request is submitted
 * Includes entity details and direct link to admin request page for assignment
 */
export async function sendAdminNewRequestNotification(
  adminEmail: string,
  submitterName: string,
  submitterRole: string,
  clientName: string,
  loanNumber: string,
  entityCount: number,
  requestId: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const isApi = submitterRole === 'api';
  const roleLabel = isApi ? 'API' : submitterRole === 'manager' ? 'Manager' : 'Processor';

  const actionLine = isApi
    ? 'Review the request and assign to an expert for Wage & Income transcript retrieval.'
    : 'Review the 8821 forms and assign to an expert when ready.';

  const content = `
<p><strong>${submitterName}</strong> (${roleLabel} at ${clientName}) submitted a new verification request.</p>
<p><strong>Request Details:</strong></p>
<ul>
  <li>Account Number: <code>${loanNumber}</code></li>
  <li>Entities: ${entityCount}</li>
  <li>Client: ${clientName}</li>
  <li>Submitted: ${new Date().toLocaleString()}</li>
</ul>
<p>${actionLine}</p>
  `.trim();

  const html = createEmailTemplate('New Request Submitted', content, {
    text: 'Review & Assign',
    url: `${appUrl}/admin/requests/${requestId}`,
  });

  try {
    await sgMail.send({
      to: adminEmail,
      from: fromEmail,
      subject: `New Request: ${loanNumber} — ${clientName} (${entityCount} ${entityCount === 1 ? 'entity' : 'entities'})`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send admin new request notification:', error);
  }
}

/**
 * Send admin notification when all entities on a request have signer emails
 * and are ready for 8821 preparation in Dropbox Sign
 */
export async function sendAdminReadyFor8821Notification(
  adminEmail: string,
  processorName: string,
  clientName: string,
  loanNumber: string,
  entities: { entity_name: string; signer_email: string; form_type: string }[],
  requestId: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const entityRows = entities
    .map((e) => `<li><strong>${e.entity_name}</strong> (${e.form_type}) → ${e.signer_email}</li>`)
    .join('\n');

  const content = `
<p>All entities for <strong>Loan ${loanNumber}</strong> (${clientName}) now have signer email addresses and are ready for 8821 preparation.</p>
<p><strong>Updated by:</strong> ${processorName}</p>
<p><strong>Entities ready for 8821:</strong></p>
<ul>
${entityRows}
</ul>
<p><strong>Next step:</strong> Create and send the 8821 forms via Dropbox Sign to the signer emails listed above.</p>
  `.trim();

  const html = createEmailTemplate('Ready for 8821 Preparation', content, {
    text: 'View Request',
    url: `${appUrl}/admin/requests/${requestId}`,
  });

  try {
    await sgMail.send({
      to: adminEmail,
      from: fromEmail,
      subject: `🟢 Ready for 8821: Loan ${loanNumber} — ${clientName} (${entities.length} ${entities.length === 1 ? 'entity' : 'entities'})`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send admin ready-for-8821 notification:', error);
  }
}

/**
 * Send daily summary to admin
 * Includes completions, errors, new requests, expert activity, and SLA compliance
 */
export async function sendAdminDailySummary(
  adminEmail: string,
  stats: AdminDailySummaryStats,
  date: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const content = `
<p>Here is your daily operations summary for <strong>${date}</strong>.</p>

<div class="stats">
  <div class="stat-item">
    <div class="stat-number">${stats.new_requests_today}</div>
    <div class="stat-label">New Entities</div>
  </div>
  <div class="stat-item">
    <div class="stat-number">${stats.completions_today}</div>
    <div class="stat-label">Completed</div>
  </div>
  <div class="stat-item">
    <div class="stat-number" style="color: ${stats.failures_today > 0 ? '#e53e3e' : '#00C48C'}">${stats.failures_today}</div>
    <div class="stat-label">Failed</div>
  </div>
</div>

<p><strong>Operations Overview:</strong></p>
<ul>
  <li>Active entities in pipeline: <strong>${stats.active_requests}</strong></li>
  <li>Entities completed today: <strong>${stats.total_entities_completed_today}</strong></li>
  <li>Entities pending: <strong>${stats.total_entities_pending}</strong></li>
</ul>

<p><strong>Expert Activity:</strong></p>
<ul>
  <li>Expert transcript completions today: <strong>${stats.expert_completions_today}</strong></li>
  <li>Expert SLA compliance rate: <strong>${stats.expert_sla_compliance}%</strong></li>
</ul>

<p><strong>Estimated Revenue:</strong></p>
<ul>
  <li>Entities completed today: ${stats.total_entities_completed_today} &times; $50 = <strong>$${(stats.total_entities_completed_today * 50).toLocaleString()}</strong></li>
</ul>

<p>Visit the admin dashboard for full details and to manage assignments.</p>
  `.trim();

  const html = createEmailTemplate('Daily Operations Summary', content, {
    text: 'Open Admin Dashboard',
    url: `${appUrl}/admin`,
  });

  try {
    await sgMail.send({
      to: adminEmail,
      from: fromEmail,
      subject: `ModernTax Daily Summary — ${date}`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send admin daily summary:', error);
  }
}

/**
 * Send weekly team summary to manager
 * Includes team completions, requests, errors, and per-processor breakdown
 */
export async function sendManagerWeeklySummary(
  managerEmail: string,
  managerName: string,
  clientName: string,
  stats: ManagerWeeklySummaryStats,
  weekRange: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const processorRows = stats.processor_breakdown.length > 0
    ? stats.processor_breakdown.map(
        (p) => `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;">${p.name}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${p.submitted}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${p.completed}</td></tr>`
      ).join('')
    : '<tr><td colspan="3" style="padding:8px 12px;text-align:center;color:#999;">No activity this week</td></tr>';

  const avgTurnaround = stats.avg_turnaround_hours !== null
    ? `${Math.round(stats.avg_turnaround_hours)} hours`
    : 'N/A';

  const content = `
<p>Hi ${managerName},</p>
<p>Here is your weekly team summary for <strong>${clientName}</strong> — ${weekRange}.</p>

<div class="stats">
  <div class="stat-item">
    <div class="stat-number">${stats.requests_submitted}</div>
    <div class="stat-label">Entities Submitted</div>
  </div>
  <div class="stat-item">
    <div class="stat-number">${stats.requests_completed}</div>
    <div class="stat-label">Entities Completed</div>
  </div>
  <div class="stat-item">
    <div class="stat-number" style="color: ${stats.requests_failed > 0 ? '#e53e3e' : '#00C48C'}">${stats.requests_failed}</div>
    <div class="stat-label">Entities Failed</div>
  </div>
</div>

<p><strong>Performance:</strong></p>
<ul>
  <li>Average turnaround time: <strong>${avgTurnaround}</strong></li>
</ul>

<p><strong>Team Breakdown:</strong></p>
<table style="width:100%;border-collapse:collapse;border:1px solid #eee;border-radius:4px;margin:16px 0;">
  <thead>
    <tr style="background:#f9f9f9;">
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #00C48C;font-size:13px;">Processor</th>
      <th style="padding:8px 12px;text-align:center;border-bottom:2px solid #00C48C;font-size:13px;">Entities Submitted</th>
      <th style="padding:8px 12px;text-align:center;border-bottom:2px solid #00C48C;font-size:13px;">Entities Completed</th>
    </tr>
  </thead>
  <tbody>
    ${processorRows}
  </tbody>
</table>

<p>Visit the dashboard to view full details and manage your team's requests.</p>
  `.trim();

  const html = createEmailTemplate('Weekly Team Summary', content, {
    text: 'View Dashboard',
    url: `${appUrl}`,
  });

  try {
    await sgMail.send({
      to: managerEmail,
      from: fromEmail,
      subject: `Weekly Team Summary: ${clientName} — ${weekRange}`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send manager weekly summary:', error);
  }
}

/**
 * Send weekly summary to processor
 * Shows their own request activity for the week
 */
export async function sendProcessorWeeklySummary(
  processorEmail: string,
  processorName: string,
  clientName: string,
  stats: {
    requests_submitted: number;
    requests_completed: number;
    requests_pending: number;
    avg_turnaround_hours: number | null;
  },
  weekRange: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const avgTurnaround = stats.avg_turnaround_hours !== null
    ? `${Math.round(stats.avg_turnaround_hours)} hours`
    : 'N/A';

  const content = `
<p>Hi ${processorName},</p>
<p>Here is your weekly summary for <strong>${clientName}</strong> — ${weekRange}.</p>

<div class="stats">
  <div class="stat-item">
    <div class="stat-number">${stats.requests_submitted}</div>
    <div class="stat-label">Entities Submitted</div>
  </div>
  <div class="stat-item">
    <div class="stat-number">${stats.requests_completed}</div>
    <div class="stat-label">Entities Completed</div>
  </div>
  <div class="stat-item">
    <div class="stat-number">${stats.requests_pending}</div>
    <div class="stat-label">Entities Pending</div>
  </div>
</div>

<p><strong>Performance:</strong></p>
<ul>
  <li>Average turnaround time: <strong>${avgTurnaround}</strong></li>
</ul>

<p>Visit the dashboard to view your requests and submit new ones.</p>
  `.trim();

  const html = createEmailTemplate('Weekly Request Summary', content, {
    text: 'View Dashboard',
    url: `${appUrl}`,
  });

  try {
    await sgMail.send({
      to: processorEmail,
      from: fromEmail,
      subject: `Weekly Summary: ${clientName} — ${weekRange}`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send processor weekly summary:', error);
  }
}
