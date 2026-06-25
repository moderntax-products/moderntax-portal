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
      categories: ['auth_password_reset'],
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
      categories: ['transactional_request_confirmation'],
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
      categories: ['transactional_transcripts_ready'],
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
      categories: ['transactional_daily_nudge'],
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
      categories: ['expert_batch_offered'],
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
      categories: ['transactional_status_change'],
    });
  } catch (error) {
    console.error('Failed to send status change notification:', error);
  }
}

/**
 * "First transcript ready" celebration email — fired exactly once per
 * client, when their FIRST EVER entity flips to status='completed'.
 *
 * High-trust moment: the manager has been waiting (often anxiously, often
 * doubting whether the platform actually works) — this is the moment to
 * mark the win, push for team expansion, and surface the next-step CTAs
 * (invite teammates, set up billing for ongoing usage).
 *
 * Caller is responsible for verifying it's actually the first completion
 * (count entities for client where status='completed' BEFORE this update
 * — if 0, send this; otherwise send the regular sendStatusChangeNotification).
 */
export async function sendFirstTranscriptCelebrationEmail(
  managerEmail: string,
  managerFirstName: string,
  clientName: string,
  entityName: string,
  loanNumber: string,
  requestId: string,
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send first-transcript email');
    return;
  }

  const content = `
<p>Hi ${managerFirstName || 'there'},</p>

<p><strong>Big moment — your first IRS transcript just landed in your portal.</strong></p>

<p>${entityName} (loan ${loanNumber}) is now complete. The Record of Account, Tax Return Transcript, and any other transcripts requested are ready to view and download.</p>

<div class="stats" style="margin: 20px 0;">
  <p style="margin: 0; font-size: 14px;"><strong>What just happened:</strong></p>
  <ul style="margin: 8px 0 0 20px; padding: 0; font-size: 13px;">
    <li>We sent a Form 8821 to your borrower for e-signature</li>
    <li>Once signed, our team called the IRS Practitioner Priority Service on your behalf</li>
    <li>Transcripts were pulled and routed straight to your portal — no fax, no waiting on hold</li>
  </ul>
</div>

<p>This is what every transcript request will look like going forward. Average turnaround: 24-48 hours from 8821 signature.</p>

<p><strong>What's next?</strong></p>
<ul>
  <li><strong>Invite your team</strong> — managers can add processors directly. Each new processor on your team multiplies how fast you can clear transcripts for your loan pipeline.</li>
  <li><strong>Set up billing</strong> — your free trial covers 3 entities. After that, requests are billed at your contracted rate. Add a payment method to keep the pipeline running.</li>
  <li><strong>Re-pull anytime</strong> — once a borrower's 8821 is on file, year-extension requests skip the signature step entirely.</li>
</ul>

<p>Welcome to ModernTax. We're glad you're here.</p>

<p>Reply with any questions — I'm in the inbox daily.</p>

<p style="margin-top: 20px;">— Matt</p>
  `.trim();

  const html = createEmailTemplate(
    `🎉 ${entityName}'s transcripts are ready`,
    content,
    { text: 'View Your First Transcript', url: `${appUrl}/request/${requestId}` },
  );

  try {
    await sgMail.send({
      to: managerEmail,
      from: fromEmail,
      subject: `🎉 ${clientName} — your first IRS transcript just landed`,
      html,
      replyTo: 'matt@moderntax.io',
      categories: ['lifecycle_first_transcript'],
    });
  } catch (error) {
    console.error('Failed to send first-transcript celebration email:', error);
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
 * Notify the SUBMITTING PROCESSOR that one of their requests needs attention.
 * Intentionally PII-FREE — no entity name, loan number, taxpayer ID, or the
 * specific reason. All of that lives in the portal behind login (+ 2FA). The
 * email is only a nudge to log in; the actual correction detail is posted as
 * an in-portal note (see update-status).
 */
export async function sendProcessorActionNeededNudge(
  processorEmail: string,
  processorName: string,
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const content = `
<p>Hi ${processorName || 'there'},</p>
<p>One of your ModernTax requests needs your attention — a correction is required before we can process it.</p>
<p>For your security, the details are in your portal. Please <strong>log in</strong> to review the request and take action.</p>
<p style="color:#6b7280;font-size:13px;">We don&rsquo;t include request or taxpayer details in email — they&rsquo;re kept behind your secure login.</p>
  `.trim();

  const html = createEmailTemplate('Action needed in your ModernTax portal', content, {
    text: 'Log in to ModernTax',
    url: `${appUrl}/login`,
  });

  try {
    await sgMail.send({
      to: processorEmail,
      from: fromEmail,
      subject: 'Action needed in your ModernTax portal',
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send processor action-needed nudge:', error);
  }
}

/**
 * Send expert overdue reminder
 * Daily reminder to experts with past-due assignments listing each entity
 */
export async function sendExpertOverdueReminder(
  expertEmail: string,
  expertName: string,
  overdueEntities: { entityName: string; clientName: string; stuckDays: number; loanNumber: string }[]
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const rows = overdueEntities
    .sort((a, b) => b.stuckDays - a.stuckDays)
    .map(
      (e) =>
        `<tr>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee; font-weight: 600;">${e.entityName}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${e.clientName}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee;">${e.loanNumber}</td>
          <td style="padding: 8px 12px; border-bottom: 1px solid #eee; color: ${e.stuckDays >= 5 ? '#dc2626' : e.stuckDays >= 3 ? '#d97706' : '#059669'}; font-weight: 600;">${e.stuckDays}d overdue</td>
        </tr>`
    )
    .join('');

  const content = `
<p>Hi ${expertName},</p>
<p>You have <strong>${overdueEntities.length} past-due ${overdueEntities.length === 1 ? 'assignment' : 'assignments'}</strong> that ${overdueEntities.length === 1 ? 'has' : 'have'} exceeded the 24-hour SLA deadline. Please prioritize completing these today:</p>
<table style="width: 100%; border-collapse: collapse; font-size: 14px; margin: 16px 0;">
  <thead>
    <tr style="background: #f5f5f5;">
      <th style="padding: 8px 12px; text-align: left;">Entity</th>
      <th style="padding: 8px 12px; text-align: left;">Client</th>
      <th style="padding: 8px 12px; text-align: left;">Loan #</th>
      <th style="padding: 8px 12px; text-align: left;">Status</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>
<p>If you're blocked on any of these (IRS system down, missing 8821, etc.), please <strong>flag the issue</strong> in your Expert Queue so admin can reassign or follow up.</p>
  `.trim();

  const html = createEmailTemplate('Overdue Assignments', content, {
    text: 'View My Queue',
    url: `${appUrl}/expert`,
  });

  try {
    await sgMail.send({
      to: expertEmail,
      from: fromEmail,
      subject: `[Overdue] ${overdueEntities.length} ${overdueEntities.length === 1 ? 'assignment' : 'assignments'} past SLA deadline`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send expert overdue reminder:', error);
  }
}

/**
 * Send admin expert accountability digest
 * Shows admin which experts have which stuck entities and total overdue counts
 */
export async function sendAdminExpertAccountabilityDigest(
  adminEmail: string,
  expertSummaries: {
    expertName: string;
    expertEmail: string;
    overdueCount: number;
    totalAssigned: number;
    entities: { entityName: string; clientName: string; stuckDays: number; loanNumber: string; status: string }[];
  }[]
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const totalOverdue = expertSummaries.reduce((sum, e) => sum + e.overdueCount, 0);

  const expertSections = expertSummaries
    .sort((a, b) => b.overdueCount - a.overdueCount)
    .map((expert) => {
      const entityRows = expert.entities
        .sort((a, b) => b.stuckDays - a.stuckDays)
        .map(
          (e) =>
            `<tr>
              <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${e.entityName}</td>
              <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${e.clientName}</td>
              <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${e.loanNumber}</td>
              <td style="padding: 6px 10px; border-bottom: 1px solid #eee;">${e.status}</td>
              <td style="padding: 6px 10px; border-bottom: 1px solid #eee; color: ${e.stuckDays >= 5 ? '#dc2626' : e.stuckDays >= 3 ? '#d97706' : '#059669'}; font-weight: 600;">${e.stuckDays}d</td>
            </tr>`
        )
        .join('');

      return `
        <div style="margin-bottom: 24px; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden;">
          <div style="background: ${expert.overdueCount >= 5 ? '#fef2f2' : expert.overdueCount >= 3 ? '#fffbeb' : '#f0fdf4'}; padding: 12px 16px; border-bottom: 1px solid #e5e7eb;">
            <strong>${expert.expertName}</strong> (${expert.expertEmail})
            <span style="float: right; font-weight: 600; color: ${expert.overdueCount >= 5 ? '#dc2626' : '#d97706'};">
              ${expert.overdueCount} overdue / ${expert.totalAssigned} total
            </span>
          </div>
          <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
            <thead>
              <tr style="background: #f9fafb;">
                <th style="padding: 6px 10px; text-align: left;">Entity</th>
                <th style="padding: 6px 10px; text-align: left;">Client</th>
                <th style="padding: 6px 10px; text-align: left;">Loan #</th>
                <th style="padding: 6px 10px; text-align: left;">Status</th>
                <th style="padding: 6px 10px; text-align: left;">Overdue</th>
              </tr>
            </thead>
            <tbody>${entityRows}</tbody>
          </table>
        </div>`;
    })
    .join('');

  const content = `
<p><strong>${totalOverdue} entities</strong> are past their SLA deadline across <strong>${expertSummaries.length} ${expertSummaries.length === 1 ? 'expert' : 'experts'}</strong>.</p>
${expertSections}
<p style="margin-top: 16px;">Each expert has been sent an automated reminder. Consider reassigning entities stuck 5+ days.</p>
  `.trim();

  const html = createEmailTemplate('Expert Accountability Digest', content, {
    text: 'View Admin Dashboard',
    url: `${appUrl}/admin`,
  });

  try {
    await sgMail.send({
      to: adminEmail,
      from: fromEmail,
      subject: `[Expert Digest] ${totalOverdue} overdue across ${expertSummaries.length} experts`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send admin expert accountability digest:', error);
  }
}

/**
 * Send fax-back 8821 request email
 * Triggered when an IRS agent rejects the digital signature on an 8821.
 * Sends instructions to the signer to print, wet-sign, and fax back the form.
 */
export async function send8821FaxRequest(
  signerEmail: string,
  signerName: string,
  entityName: string,
  formType: string,
  _requestId: string,
  signed8821Url: string | null
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const faxNumber = '+1 (415) 900-4436';
  const attentionLine = 'ModernTax Expert Team';

  const content = `
<p>Hi ${signerName},</p>
<p>We recently submitted your Form 8821 (Tax Information Authorization) for <strong>${entityName}</strong> to the IRS, but the IRS agent has <strong>requested a wet ink signature</strong> instead of the digital signature on file.</p>
<p>To keep your request moving forward, we need you to:</p>
<div style="background-color: #f0f9ff; border: 1px solid #bae6fd; border-radius: 8px; padding: 20px; margin: 24px 0;">
  <p style="font-weight: 700; font-size: 16px; margin: 0 0 12px 0; color: #0369a1;">Fax-Back Instructions</p>
  <ol style="margin: 0; padding-left: 20px;">
    <li style="margin-bottom: 8px;"><strong>Print</strong> the attached Form 8821${signed8821Url ? ' (also linked below)' : ''}</li>
    <li style="margin-bottom: 8px;"><strong>Sign</strong> the form with a <strong>wet ink signature</strong> (pen on paper)</li>
    <li style="margin-bottom: 8px;"><strong>Fax</strong> the signed form to:</li>
  </ol>
  <div style="background-color: #ffffff; border: 2px solid #0369a1; border-radius: 6px; padding: 16px; margin: 12px 0 0 0; text-align: center;">
    <p style="font-size: 20px; font-weight: 700; color: #0369a1; margin: 0;">${faxNumber}</p>
    <p style="font-size: 14px; color: #64748b; margin: 4px 0 0 0;">ATTN: ${attentionLine}</p>
    <p style="font-size: 12px; color: #94a3b8; margin: 4px 0 0 0;">Reference: ${entityName} — ${formType}</p>
  </div>
</div>
<p><strong>No fax machine?</strong> You can use a free online fax service like <a href="https://faxzero.com" style="color: #00C48C;">FaxZero</a> or a mobile scanning app (CamScanner, Adobe Scan) to fax from your phone or computer.</p>
<p style="font-size: 13px; color: #666;">Once we receive your faxed form, our team will resubmit to the IRS and continue processing your request. Typical turnaround after receiving the fax is 1-2 business days.</p>
<p style="font-size: 13px; color: #666;">If you have questions, reply to this email or contact us at <a href="mailto:support@moderntax.io" style="color: #00C48C;">support@moderntax.io</a>.</p>
  `.trim();

  const html = createEmailTemplate('Wet Signature Required — Form 8821', content, signed8821Url ? {
    text: 'Download Form 8821',
    url: signed8821Url,
  } : undefined);

  try {
    await sgMail.send({
      to: signerEmail,
      from: fromEmail,
      subject: `Action Required: Wet Signature Needed for ${entityName} — Form 8821`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send 8821 fax request email:', error);
    throw error;
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
 * Notify admin that Clearfirm 8821s have been auto-sent and are ready for wet signature download
 */
export async function sendClearfirmBotNotification(
  adminEmail: string,
  entities: { entityName: string; formType: string; loanNumber: string; signatureRequestId: string }[],
  designeeName: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const entityRows = entities
    .map(
      (e) =>
        `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;">${e.entityName}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;">${e.formType}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;">${e.loanNumber}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px;">${e.signatureRequestId.slice(0, 16)}...</td>
        </tr>`
    )
    .join('\n');

  const content = `
<p>The Clearfirm 8821 Bot has automatically processed <strong>${entities.length}</strong> new ${entities.length === 1 ? 'entity' : 'entities'}.</p>

<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:16px;margin:16px 0;">
  <p style="margin:0 0 4px;font-size:12px;color:#1e40af;text-transform:uppercase;font-weight:600;">Designee</p>
  <p style="margin:0;font-size:16px;font-weight:700;color:#1e3a5f;">${designeeName}</p>
</div>

<p><strong>8821 signature requests have been sent via Dropbox Sign.</strong> Once signed, download the wet-signature PDFs from Dropbox Sign and upload them to the portal.</p>

<table style="width:100%;border-collapse:collapse;margin:16px 0;">
  <thead>
    <tr style="background:#f8fafc;">
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b;">Entity</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b;">Form</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b;">Loan #</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e2e8f0;font-size:12px;color:#64748b;">Signature ID</th>
    </tr>
  </thead>
  <tbody>
    ${entityRows}
  </tbody>
</table>

<p style="font-size:13px;color:#64748b;"><strong>Next steps:</strong></p>
<ol style="font-size:13px;color:#64748b;">
  <li>Wait for signer to complete wet signature on the 8821</li>
  <li>Download signed PDF from <a href="https://app.hellosign.com/home/manage" style="color:#2563eb;">Dropbox Sign</a></li>
  <li>Upload to portal (auto-synced by cron, or manual upload via Clearfirm Bot page)</li>
</ol>
  `.trim();

  const html = createEmailTemplate(
    `Clearfirm Bot: ${entities.length} 8821${entities.length === 1 ? '' : 's'} Sent`,
    content,
    {
      text: 'Open Clearfirm Bot Dashboard',
      url: `${appUrl}/admin/clearfirm-bot`,
    }
  );

  try {
    await sgMail.send({
      to: adminEmail,
      from: fromEmail,
      subject: `Clearfirm Bot: ${entities.length} 8821${entities.length === 1 ? '' : 's'} sent — awaiting wet signatures`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send Clearfirm bot notification:', error);
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

<p><strong>Revenue from today's completions</strong> <span style="color:#6b7280;font-size:12px;">(live, per-client billing rates)</span></p>
<ul>
${stats.revenue_breakdown.length === 0
  ? '  <li style="color:#6b7280;">No billable completions today.</li>'
  : stats.revenue_breakdown.map(b => `  <li>${b.client_name.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))}: ${b.billable_entities} billable${b.free_entities > 0 ? ` + ${b.free_entities} free-trial` : ''} = <strong>$${b.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></li>`).join('\n')}
  <li style="border-top:1px solid #e5e7eb;padding-top:6px;margin-top:6px;"><strong>Total billable revenue: $${stats.revenue_today.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>${stats.free_trial_entities_today > 0 ? ` <span style="color:#6b7280;">(${stats.free_trial_entities_today} free-trial entit${stats.free_trial_entities_today === 1 ? 'y' : 'ies'} excluded)</span>` : ''}</li>
</ul>

${stats.cogs ? `
<p><strong>Cost of Goods Sold (today)</strong> <span style="color:#6b7280;font-size:12px;">(infra + voice + e-sign + AI + payments + expert payouts)</span></p>
<table style="width:100%;border-collapse:collapse;font-size:13px;">
  <thead>
    <tr style="background:#f9fafb;border-bottom:1px solid #e5e7eb;">
      <th style="text-align:left;padding:6px 8px;font-weight:600;color:#374151;">Category</th>
      <th style="text-align:left;padding:6px 8px;font-weight:600;color:#374151;">Detail</th>
      <th style="text-align:right;padding:6px 8px;font-weight:600;color:#374151;">Amount</th>
    </tr>
  </thead>
  <tbody>
${stats.cogs.line_items.map(li => `    <tr style="border-bottom:1px solid #f3f4f6;">
      <td style="padding:6px 8px;color:#111827;">${li.label}</td>
      <td style="padding:6px 8px;color:#6b7280;font-size:12px;">${li.detail.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))}</td>
      <td style="padding:6px 8px;text-align:right;color:#111827;font-variant-numeric:tabular-nums;">$${li.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    </tr>`).join('\n')}
    <tr style="border-top:2px solid #e5e7eb;background:#fafafa;">
      <td colspan="2" style="padding:6px 8px;font-weight:600;color:#111827;">Total COGS</td>
      <td style="padding:6px 8px;text-align:right;font-weight:600;color:#111827;font-variant-numeric:tabular-nums;">$${stats.cogs.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    </tr>
${stats.gross_margin ? `    <tr>
      <td colspan="2" style="padding:6px 8px;font-weight:600;color:${stats.gross_margin.dollars >= 0 ? '#047857' : '#b91c1c'};">Gross margin <span style="color:#6b7280;font-weight:400;">(revenue − COGS)</span></td>
      <td style="padding:6px 8px;text-align:right;font-weight:600;color:${stats.gross_margin.dollars >= 0 ? '#047857' : '#b91c1c'};font-variant-numeric:tabular-nums;">$${stats.gross_margin.dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} <span style="font-weight:400;font-size:12px;">(${stats.gross_margin.pct}%)</span></td>
    </tr>` : ''}
  </tbody>
</table>
${stats.cogs.warnings.length > 0 ? `<p style="font-size:11px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;margin-top:8px;"><strong>Telemetry gaps:</strong> ${stats.cogs.warnings.map(w => w.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!))).join(' · ')}</p>` : ''}
` : ''}

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

/**
 * Send manager notification when processor orders Entity Transcript add-on
 * Alerts manager to the additional cost and entities selected
 */
export async function sendManagerEntityTranscriptNotification(
  managerEmail: string,
  processorName: string,
  clientName: string,
  loanNumber: string,
  entityCount: number,
  totalCost: number,
  requestId: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const content = `
<p><strong>${processorName}</strong> ordered the Entity Transcript add-on for a new request.</p>
<p><strong>Order Details:</strong></p>
<ul>
  <li>Client: ${clientName}</li>
  <li>Account Number: <code>${loanNumber}</code></li>
  <li>Entities with Entity Transcript: ${entityCount}</li>
  <li>Add-on Cost: $${totalCost.toFixed(2)} (${entityCount} × $19.99)</li>
  <li>Ordered: ${new Date().toLocaleString()}</li>
</ul>
<p>Entity Transcripts confirm IRS filing requirements before income transcripts are pulled, reducing blank results.</p>
  `.trim();

  const html = createEmailTemplate('Entity Transcript Add-On Ordered', content, {
    text: 'View Request',
    url: `${appUrl}/request/${requestId}`,
  });

  try {
    await sgMail.send({
      to: managerEmail,
      from: fromEmail,
      subject: `Entity Transcript Add-On: ${loanNumber} by ${processorName}`,
      html,
      replyTo: 'support@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send manager entity transcript notification:', error);
  }
}

/**
 * Send daily IRS call schedule email to expert
 * Shows pending assignments and lets expert pick a time slot for automated PPS call + callback
 */
export async function sendExpertDailyCallSchedule(
  expertEmail: string,
  expertName: string,
  _expertId: string,
  pendingEntities: {
    entityName: string;
    tidKind: string;
    formType: string;
    years: string[];
    assignmentId: string;
    daysAssigned: number;
  }[],
  scheduleToken: string
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send email');
    return;
  }

  const firstName = expertName.split(',')[0].split(' ')[0];
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  const entityRows = pendingEntities
    .sort((a, b) => b.daysAssigned - a.daysAssigned)
    .map(
      (e) =>
        `<tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #eee; font-weight: 600;">${e.entityName}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${e.tidKind}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${e.formType} (${e.years.join(', ')})</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #eee; color: ${e.daysAssigned >= 3 ? '#dc2626' : e.daysAssigned >= 1 ? '#d97706' : '#059669'}; font-weight: 600;">${e.daysAssigned}d</td>
        </tr>`
    )
    .join('');

  // Generate time slot buttons — IRS PPS hours 7 AM - 7 PM ET
  const timeSlots = [
    { label: '7:00 AM', value: '07:00' },
    { label: '8:00 AM', value: '08:00' },
    { label: '9:00 AM', value: '09:00' },
    { label: '10:00 AM', value: '10:00' },
    { label: '11:00 AM', value: '11:00' },
    { label: '12:00 PM', value: '12:00' },
    { label: '1:00 PM', value: '13:00' },
    { label: '2:00 PM', value: '14:00' },
    { label: '3:00 PM', value: '15:00' },
    { label: '4:00 PM', value: '16:00' },
    { label: '5:00 PM', value: '17:00' },
    { label: '6:00 PM', value: '18:00' },
  ];

  const slotButtons = timeSlots
    .map(
      (slot) =>
        `<a href="${appUrl}/expert/schedule?token=${scheduleToken}&time=${slot.value}"
            style="display: inline-block; padding: 10px 16px; margin: 4px; background: #f0fdf4; border: 2px solid #00C48C; border-radius: 8px; text-decoration: none; color: #065f46; font-weight: 600; font-size: 14px; min-width: 80px; text-align: center;">
          ${slot.label}
        </a>`
    )
    .join('');

  const content = `
<p>Good morning ${firstName},</p>

<p>You have <strong>${pendingEntities.length} pending ${pendingEntities.length === 1 ? 'entity' : 'entities'}</strong> that need IRS PPS calls today:</p>

<table style="width: 100%; border-collapse: collapse; font-size: 14px; margin: 16px 0;">
  <thead>
    <tr style="background: #f5f5f5;">
      <th style="padding: 10px 12px; text-align: left;">Entity</th>
      <th style="padding: 10px 12px; text-align: left;">Type</th>
      <th style="padding: 10px 12px; text-align: left;">Transcripts</th>
      <th style="padding: 10px 12px; text-align: left;">Waiting</th>
    </tr>
  </thead>
  <tbody>${entityRows}</tbody>
</table>

<div style="background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%); border-radius: 12px; padding: 24px; margin: 24px 0; border: 1px solid #bbf7d0;">
  <h3 style="margin: 0 0 8px 0; color: #065f46; font-size: 16px;">Pick a time — we'll call the IRS for you</h3>
  <p style="margin: 0 0 16px 0; font-size: 14px; color: #047857;">
    Our AI will call the IRS PPS line, navigate the phone tree, and <strong>request a callback to your phone</strong>.
    You'll get an email with the estimated callback time so you can be ready when the IRS calls.
  </p>
  <p style="margin: 0 0 12px 0; font-size: 13px; color: #6b7280;">Select when you'll be available today (all times ET):</p>
  <div style="text-align: center;">
    ${slotButtons}
  </div>
</div>

<p style="font-size: 13px; color: #6b7280; margin-top: 16px;">
  <strong>How it works:</strong> Click a time slot → AI calls IRS at that time → AI requests a callback to your phone →
  You get an email with the ETA → IRS calls you back directly. No hold time for you!
</p>
  `.trim();

  const html = createEmailTemplate(`IRS Call Schedule — ${dateStr}`, content);

  try {
    await sgMail.send({
      to: expertEmail,
      from: fromEmail,
      subject: `[Action Required] ${pendingEntities.length} IRS ${pendingEntities.length === 1 ? 'call' : 'calls'} ready — pick your time`,
      html,
      replyTo: 'matt@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send expert daily call schedule:', error);
  }
}

/**
 * Send expert a notification that the IRS callback has been accepted.
 * Tells them the ETA and which entities are pending.
 */
export async function sendExpertCallbackNotification(
  expertEmail: string,
  expertName: string,
  callbackPhone: string,
  estimatedWaitMinutes: number,
  entities: {
    taxpayerName: string;
    formType: string;
    years: string[];
  }[]
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send callback notification');
    return;
  }

  const firstName = expertName.split(',')[0].split(' ')[0];
  const etaNow = new Date();
  const etaTime = new Date(etaNow.getTime() + estimatedWaitMinutes * 60 * 1000);
  const etaStr = etaTime.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });

  const entityList = entities
    .map((e) => `<li><strong>${e.taxpayerName}</strong> — ${e.formType} (${e.years.join(', ')})</li>`)
    .join('');

  const content = `
<p>Hi ${firstName},</p>

<p>Our AI just called the IRS PPS line on your behalf and <strong>secured a callback</strong>.</p>

<div style="background: #f0fdf4; border: 2px solid #00C48C; border-radius: 12px; padding: 20px; margin: 20px 0; text-align: center;">
  <p style="margin: 0 0 4px 0; font-size: 14px; color: #6b7280;">Estimated IRS callback by</p>
  <p style="margin: 0; font-size: 32px; font-weight: 700; color: #065f46;">${etaStr} ET</p>
  <p style="margin: 8px 0 0 0; font-size: 14px; color: #6b7280;">to <strong>${callbackPhone}</strong></p>
</div>

<p><strong>Please be ready to answer your phone.</strong> When the IRS calls back, a live agent will be on the line ready to help with:</p>

<ul style="margin: 12px 0; padding-left: 20px;">
${entityList}
</ul>

<p style="font-size: 13px; color: #6b7280;">
  <strong>What to have ready:</strong> Your CAF number, the signed 8821 forms, and any taxpayer details for the entities above.
  The IRS agent may ask you to fax the 8821 — have access to a fax or efax service.
</p>
  `.trim();

  const html = createEmailTemplate('IRS Callback Scheduled', content);

  try {
    await sgMail.send({
      to: expertEmail,
      from: fromEmail,
      subject: `IRS calling you back ~${etaStr} ET — be ready to answer`,
      html,
      replyTo: 'matt@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send expert callback notification:', error);
  }
}

/**
 * Send processor/manager a backlog status email
 * Shows their pending requests, what's blocking each one, and timeline expectations
 */
export async function sendProcessorBacklogNotification(
  processorEmail: string,
  processorName: string,
  clientName: string,
  pendingRequests: {
    loanNumber: string;
    status: string;
    ageDisplay: string;
    ageDays: number;
    entities: {
      name: string;
      status: string;
      expertName: string | null;
      blocker: string;
    }[];
  }[],
  summary: {
    totalPending: number;
    awaitingSignature: number;
    inIrsQueue: number;
    unassigned: number;
    staleCount: number;
  },
  /**
   * Optional — "Questions awaiting your decision" section, rendered ONLY when non-empty.
   * Each item is an entity where the expert needs a processor decision to unblock
   * (e.g. "partial transcripts on file — accept as-is or pull fresh?"). This is the
   * interim Option-C mechanism until a proper in-app resolution UI is built.
   */
  backfillQuestions?: {
    entityId: string;
    entityName: string;
    loanNumber: string;
    requestId: string;
    question: string;
  }[],
): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send backlog notification');
    return;
  }

  const firstName = processorName.split(' ')[0];

  const statusLabels: Record<string, string> = {
    'pending': 'Pending',
    'submitted': 'Submitted',
    '8821_sent': '8821 Sent',
    '8821_signed': '8821 Signed',
    'irs_queue': 'IRS Queue',
    'processing': 'Processing',
  };

  const blockerColors: Record<string, string> = {
    'awaiting_signature': '#3b82f6',
    'needs_expert': '#d97706',
    'irs_queue': '#f59e0b',
    'processing': '#8b5cf6',
    'stale': '#dc2626',
  };

  const requestRows = pendingRequests.map((req) => {
    const ageColor = req.ageDays >= 7 ? '#dc2626' : req.ageDays >= 3 ? '#d97706' : '#059669';
    const entityLines = req.entities.map((e) => {
      const blockerColor = blockerColors[e.blocker] || '#6b7280';
      // Processor-facing email: anonymize the individual expert. The
      // processor only sees the ModernTax org as a single counterparty.
      // Driver: 2026-05-28 Matt — "Notes from experts should not include
      // expert name on any processor/manager-facing communications."
      // We still distinguish assigned vs unassigned because that's a
      // meaningful state for the processor to know about.
      const expertLabel = e.expertName
        ? 'ModernTax'
        : '<span style="color: #dc2626; font-weight: 600;">Unassigned</span>';
      return `<tr style="border-bottom: 1px solid #f3f4f6;">
        <td style="padding: 6px 12px; font-size: 13px;">${e.name}</td>
        <td style="padding: 6px 12px; font-size: 12px;"><span style="background: ${blockerColor}15; color: ${blockerColor}; padding: 2px 8px; border-radius: 12px; font-weight: 600;">${statusLabels[e.status] || e.status}</span></td>
        <td style="padding: 6px 12px; font-size: 12px;">${expertLabel}</td>
      </tr>`;
    }).join('');

    return `
      <div style="border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 12px; overflow: hidden;">
        <div style="background: #f9fafb; padding: 10px 16px; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <strong style="font-size: 14px; color: #111827;">${req.loanNumber}</strong>
            <span style="margin-left: 8px; font-size: 12px; background: ${ageColor}15; color: ${ageColor}; padding: 2px 8px; border-radius: 12px; font-weight: 600;">${req.ageDisplay} old</span>
          </div>
          <span style="font-size: 12px; color: #6b7280;">${statusLabels[req.status] || req.status}</span>
        </div>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr style="border-bottom: 1px solid #e5e7eb;">
              <th style="padding: 6px 12px; text-align: left; font-size: 11px; color: #6b7280; text-transform: uppercase;">Entity</th>
              <th style="padding: 6px 12px; text-align: left; font-size: 11px; color: #6b7280; text-transform: uppercase;">Status</th>
              <th style="padding: 6px 12px; text-align: left; font-size: 11px; color: #6b7280; text-transform: uppercase;">Expert</th>
            </tr>
          </thead>
          <tbody>${entityLines}</tbody>
        </table>
      </div>`;
  }).join('');

  // Timeline expectations section
  const timelineItems: string[] = [];
  if (summary.awaitingSignature > 0) {
    timelineItems.push(`<li><strong>${summary.awaitingSignature} entit${summary.awaitingSignature === 1 ? 'y' : 'ies'}</strong> waiting for 8821 signature — once signed, transcripts typically take <strong>1-2 business days</strong>.</li>`);
  }
  if (summary.inIrsQueue > 0) {
    timelineItems.push(`<li><strong>${summary.inIrsQueue} entit${summary.inIrsQueue === 1 ? 'y is' : 'ies are'}</strong> in the IRS queue — our experts are actively working these. Expected turnaround: <strong>same day to 24 hours</strong> once assigned.</li>`);
  }
  if (summary.unassigned > 0) {
    timelineItems.push(`<li><strong>${summary.unassigned} entit${summary.unassigned === 1 ? 'y' : 'ies'}</strong> pending expert assignment — we are assigning these now and will begin processing shortly.</li>`);
  }
  if (summary.staleCount > 0) {
    timelineItems.push(`<li style="color: #dc2626;"><strong>${summary.staleCount} request${summary.staleCount === 1 ? '' : 's'}</strong> older than 3 days — we are prioritizing these and will provide an update within 24 hours.</li>`);
  }

  // Backfill-questions section — only rendered when items exist. Each row has
  // an amber callout, the entity name + loan, the question, and a deep link
  // back to the request page so the processor can respond.
  const hasQuestions = Array.isArray(backfillQuestions) && backfillQuestions.length > 0;
  const questionsBlock = hasQuestions ? `
<div style="background: #fffbeb; border: 2px solid #f59e0b; border-radius: 10px; padding: 16px; margin: 24px 0;">
  <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
    <span style="font-size: 18px;">⚠️</span>
    <h3 style="font-size: 15px; color: #92400e; margin: 0; font-weight: 700;">
      ${backfillQuestions!.length} Question${backfillQuestions!.length === 1 ? '' : 's'} Awaiting Your Decision
    </h3>
  </div>
  <p style="font-size: 12px; color: #78350f; margin: 0 0 12px;">
    Our expert needs your input on ${backfillQuestions!.length === 1 ? 'this entity' : 'these entities'} before proceeding.
    Please reply to this email or open the request to let us know how to proceed.
  </p>
  ${backfillQuestions!.map(q => `
    <div style="background: white; border: 1px solid #fcd34d; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px;">
      <div style="font-size: 13px; font-weight: 600; color: #111827; margin-bottom: 4px;">
        ${q.entityName} <span style="color: #6b7280; font-weight: 400; font-size: 12px;">· Loan ${q.loanNumber}</span>
      </div>
      <div style="font-size: 12px; color: #374151; line-height: 1.5; margin-bottom: 6px;">
        ${q.question}
      </div>
      <a href="${appUrl}/request/${q.requestId}" style="font-size: 12px; color: #b45309; text-decoration: underline; font-weight: 600;">
        Review & respond →
      </a>
    </div>
  `).join('')}
</div>` : '';

  const content = `
<p>Hi ${firstName},</p>

<p>Here is a status update on your pending verification requests at <strong>${clientName}</strong>.</p>
${questionsBlock}
<div style="display: flex; gap: 16px; margin: 20px 0;">
  <div style="flex: 1; text-align: center; padding: 16px; background: #f9fafb; border-radius: 8px; border: 1px solid #e5e7eb;">
    <div style="font-size: 28px; font-weight: 700; color: #111827;">${summary.totalPending}</div>
    <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Pending</div>
  </div>
  <div style="flex: 1; text-align: center; padding: 16px; background: ${summary.staleCount > 0 ? '#fef2f2' : '#f0fdf4'}; border-radius: 8px; border: 1px solid ${summary.staleCount > 0 ? '#fecaca' : '#bbf7d0'};">
    <div style="font-size: 28px; font-weight: 700; color: ${summary.staleCount > 0 ? '#dc2626' : '#059669'};">${summary.staleCount}</div>
    <div style="font-size: 11px; color: #6b7280; text-transform: uppercase;">Stale (3+ days)</div>
  </div>
</div>

<h3 style="font-size: 14px; color: #374151; margin: 24px 0 12px;">Request Details</h3>
${requestRows}

<h3 style="font-size: 14px; color: #374151; margin: 24px 0 12px;">Timeline Expectations</h3>
<ul style="margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.8;">
  ${timelineItems.join('\n  ')}
</ul>

<p style="margin-top: 20px; font-size: 13px; color: #6b7280;">
  If any 8821 forms are still awaiting signature, please check with your borrowers to ensure they complete the e-sign process.
  This is the most common cause of delays.
</p>
  `.trim();

  const html = createEmailTemplate('Request Backlog Update', content, {
    text: 'View Dashboard',
    url: `${appUrl}`,
  });

  try {
    await sgMail.send({
      to: processorEmail,
      from: { email: fromEmail, name: 'ModernTax' },
      subject: hasQuestions
        ? `⚠️ ${backfillQuestions!.length} question${backfillQuestions!.length === 1 ? '' : 's'} awaiting your decision + ${summary.totalPending} pending — ${clientName}`
        : `Backlog Update: ${summary.totalPending} pending request${summary.totalPending !== 1 ? 's' : ''} — ${clientName}`,
      html,
      replyTo: 'matt@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send processor backlog notification:', error);
  }
}

// ---------------------------------------------------------------------------
// Trial onboarding drip
// ---------------------------------------------------------------------------

export interface TrialWelcomeEmailOptions {
  toEmail: string;
  firstName: string;
  clientName: string;
  /** Signed token that the unsubscribe endpoint uses to identify the profile without auth. */
  unsubscribeToken: string;
  /** Which email in the sequence is this (1 = first, 2 = 48h reminder, ...). Shifts CTA urgency. */
  sendNumber: number;
}

/**
 * Self-serve trial onboarding welcome email.
 *
 * Sent the moment a new trial account is provisioned, then re-sent every 48h
 * until the user signs in + submits their first request OR unsubscribes.
 * The re-send cadence is driven by /api/cron/trial-welcome-drip.
 *
 * Key messages:
 *   1. 4-step flow (portal → auto-generated 8821 → borrower signs → same-day transcripts)
 *   2. We do NOT reuse old 8821s — every request gets a fresh, Matt-designated form
 *      (CAF 0316-30210R), which avoids the "wrong designee" rejection path we've
 *      seen with legacy HelloSign/Dropbox Sign flows at other providers.
 *   3. 90-second Loom (URL swapped in via TRIAL_WELCOME_LOOM_URL env; TBD placeholder
 *      while the video is being produced).
 *   4. Cal Statewide social proof.
 *   5. Single CTA — submit the first trial entity.
 */
export async function sendTrialWelcomeEmail(opts: TrialWelcomeEmailOptions): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured — cannot send trial welcome email');
    return;
  }

  const { toEmail, firstName, clientName, unsubscribeToken, sendNumber } = opts;
  const loomUrl = process.env.TRIAL_WELCOME_LOOM_URL || `${appUrl}/tour`; // placeholder until the Loom is produced
  const submitUrl = `${appUrl}/new`;
  const unsubscribeUrl = `${appUrl}/api/unsubscribe/trial-welcome?token=${encodeURIComponent(unsubscribeToken)}`;

  // Subject line shifts urgency as the sequence progresses.
  const subject = sendNumber === 1
    ? `${firstName}, your 3 free ModernTax trial requests are ready`
    : sendNumber === 2
      ? `Still waiting on your first trial request, ${firstName}?`
      : `Your 3 free trial requests are still here whenever you're ready`;

  // A quick reminder banner that appears on re-sends (send #2+) so it doesn't
  // read as a duplicate of the first email.
  const reminderBanner = sendNumber > 1
    ? `<div style="background:#fef3c7;border-left:3px solid #f59e0b;padding:10px 14px;margin:0 0 16px;border-radius:6px;font-size:13px;color:#78350f;">
         Gentle reminder — we noticed you haven't submitted your first request yet.
         The 3 free trial requests don't expire, so take your time. Below is the same
         overview we sent when your account was provisioned, in case it slipped by.
       </div>`
    : '';

  const content = `
${reminderBanner}
<p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Hi ${firstName},</p>

<p style="font-size:14px;line-height:1.6;color:#1f2937;">
  Your <strong>${clientName}</strong> account on <a href="${appUrl}">portal.moderntax.io</a> is live and
  your <strong>3 free trial transcript requests</strong> are loaded and waiting. Here's the full flow so you
  know exactly what to expect.
</p>

<!-- 4-step flow -->
<table role="presentation" style="width:100%;margin:20px 0;border-collapse:separate;border-spacing:0 8px;">
  <tr>
    <td style="width:32px;vertical-align:top;padding-top:4px;">
      <span style="display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;background:#2563eb;color:#fff;border-radius:50%;font-size:12px;font-weight:700;">1</span>
    </td>
    <td style="font-size:14px;line-height:1.6;color:#1f2937;">
      <strong>Create a request in the portal.</strong> One loan number, one or more entities.
      Takes 30 seconds — borrower's name, TIN, form type, years.
    </td>
  </tr>
  <tr>
    <td style="vertical-align:top;padding-top:4px;">
      <span style="display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;background:#2563eb;color:#fff;border-radius:50%;font-size:12px;font-weight:700;">2</span>
    </td>
    <td style="font-size:14px;line-height:1.6;color:#1f2937;">
      <strong>We auto-generate a fresh, pre-filled Form 8821</strong> using the ModernTax template
      with <em>Matthew Parker / ModernTax Inc, CAF 0316-30210R</em> as the primary designee (backup
      designee auto-included). No copy-pasting old 8821s — every request gets its own.
    </td>
  </tr>
  <tr>
    <td style="vertical-align:top;padding-top:4px;">
      <span style="display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;background:#2563eb;color:#fff;border-radius:50%;font-size:12px;font-weight:700;">3</span>
    </td>
    <td style="font-size:14px;line-height:1.6;color:#1f2937;">
      <strong>Borrower e-signs via Dropbox Sign.</strong> We email them directly; you get notified when
      they open, view, and sign. Usually minutes — sometimes same coffee break.
    </td>
  </tr>
  <tr>
    <td style="vertical-align:top;padding-top:4px;">
      <span style="display:inline-block;width:24px;height:24px;line-height:24px;text-align:center;background:#10b981;color:#fff;border-radius:50%;font-size:12px;font-weight:700;">4</span>
    </td>
    <td style="font-size:14px;line-height:1.6;color:#1f2937;">
      <strong>Same-day transcripts delivered.</strong> Our expert pulls from IRS TDS / PPS and the signed
      HTMLs and PDFs land in the portal (and we webhook them to your LOS if you use the API).
      Typical turnaround: <strong>&lt; 4 hours during business hours</strong>.
    </td>
  </tr>
</table>

<!-- Why fresh 8821s matter -->
<div style="background:#f0f9ff;border-left:3px solid #0284c7;padding:12px 16px;margin:24px 0;border-radius:6px;">
  <p style="font-size:13px;line-height:1.6;color:#0c4a6e;margin:0;">
    <strong>Why we don't reuse old 8821s.</strong> A lot of providers keep an 8821 on file and reuse it across loans
    and borrowers — it's faster, but it also fails IRS PPS verification the moment the designee's CAF number
    doesn't match what the IRS has on file for that specific authorization. We generate every 8821 fresh with
    <code style="background:#e0f2fe;padding:1px 5px;border-radius:3px;">CAF 0316-30210R</code> baked in and a
    secondary designee always listed. Practitioner Priority Service accepts it first try.
  </p>
</div>

<!-- Loom -->
<div style="margin:28px 0;text-align:center;">
  <a href="${loomUrl}" style="display:inline-block;background:#000;color:#fff;padding:14px 28px;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600;">
    ▶ Watch the 90-second walkthrough
  </a>
  <p style="font-size:11px;color:#6b7280;margin:8px 0 0;">See the full flow end-to-end before you start.</p>
</div>

<!-- Social proof -->
<blockquote style="border-left:3px solid #10b981;padding:14px 18px;margin:28px 0;background:#f0fdf4;border-radius:0 6px 6px 0;">
  <p style="font-size:14px;font-style:italic;line-height:1.6;color:#065f46;margin:0;">
    "ModernTax turned a 2-day 8821 + transcript scramble into something that actually happens the same morning
    we open the file. Our underwriters stopped calling us about missing transcripts."
  </p>
  <p style="font-size:12px;color:#059669;margin:8px 0 0;">
    — <strong>California Statewide CDC</strong>, SBA 504 lender
  </p>
</blockquote>

<!-- CTA -->
<div style="margin:32px 0 20px;text-align:center;">
  <a href="${submitUrl}" style="display:inline-block;background:#059669;color:#fff;padding:16px 36px;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;box-shadow:0 2px 4px rgba(5,150,105,0.2);">
    Submit your first trial entity →
  </a>
  <p style="font-size:12px;color:#6b7280;margin:10px 0 0;">
    Takes 30 seconds. 2 more free requests after this one.
  </p>
</div>

<p style="font-size:13px;line-height:1.6;color:#4b5563;margin-top:28px;">
  Hit reply if you want a hands-on walkthrough — I'll block 15 minutes and we'll run your first request live.
</p>

<p style="font-size:14px;color:#1f2937;margin-top:20px;">
  Best,<br>
  Matthew Parker<br>
  <span style="color:#6b7280;font-size:12px;">matt@moderntax.io · 650-741-1085 · ModernTax, Inc.</span>
</p>

<!-- Unsubscribe footer -->
<hr style="border:none;border-top:1px solid #e5e7eb;margin:28px 0 16px;">
<p style="font-size:11px;color:#9ca3af;line-height:1.5;text-align:center;margin:0;">
  You're getting this because you activated a free trial at ModernTax.
  <a href="${unsubscribeUrl}" style="color:#6b7280;text-decoration:underline;">Unsubscribe from trial reminders</a>
  — we'll stop these immediately. You'll still receive transcripts and account emails.
</p>
`.trim();

  const html = createEmailTemplate(
    sendNumber === 1 ? 'Your trial is ready' : 'Your trial requests are waiting',
    content,
    { text: 'Submit your first trial entity', url: submitUrl },
  );

  try {
    await sgMail.send({
      to: toEmail,
      from: { email: fromEmail, name: 'Matthew Parker, ModernTax' },
      subject,
      html,
      replyTo: 'matt@moderntax.io',
      // RFC 8058 one-click unsubscribe — improves inbox placement + lets clients
      // auto-suppress without a round-trip to the portal. Paired with the
      // unsubscribe link in the footer for clients that don't render the button.
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  } catch (error) {
    console.error('Failed to send trial welcome email:', error);
    throw error;
  }
}

/**
 * Free-credit activation broadcast — focused entirely on getting new
 * users to log in and place their first order. Single message, single
 * CTA, no feature-tour distraction. Same template fires for every role
 * (manager / processor / admin); the credit is account-wide so anyone
 * can be the one who places the first order.
 *
 * Triggered by /api/admin/send-feature-update (admin-only, dryRun=true
 * by default). Each call accepts one recipient; the endpoint loops over
 * the targeted user list and sends in batches.
 */
export async function sendFeatureUpdateEmail(
  toEmail: string,
  recipientName: string,
  // Role kept in the signature for API compatibility but no longer
  // changes the message — credits are account-wide and the goal is
  // identical for everyone: place a first order.
  _role: 'manager' | 'processor' | 'admin',
): Promise<void> {
  const orderUrl = `${appUrl}/new`;
  const subject = '$239.94 in free credits — place your first order';

  const content = `
<p>Hi ${recipientName || 'there'},</p>

<p>Your ModernTax account has <strong>$239.94 in free credits</strong> waiting — that covers your first <strong>3 transcript verifications</strong> at no cost. The credit is shared across your whole team, so anyone (you or a teammate) can be the one to place that first order.</p>

<div style="background-color:#ECFDF5;border:1px solid #A7F3D0;border-radius:8px;padding:20px;margin:24px 0;text-align:center;">
  <p style="font-size:13px;color:#047857;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 4px;font-weight:600;">Account credit available</p>
  <p style="font-size:36px;font-weight:700;color:#047857;margin:0;line-height:1;">$239.94</p>
  <p style="font-size:13px;color:#065F46;margin:8px 0 0;">3 free transcript verifications · for the entire team</p>
</div>

<p>Takes about 30 seconds to place your first order. Pick the path that fits — upload a CSV for a batch, drop a signed 8821 PDF, or type a single borrower's details directly.</p>

<p style="font-size:14px;color:#1f2937;margin-top:24px;">
  Best,<br>
  Matthew Parker<br>
  <span style="color:#6b7280;font-size:12px;">matt@moderntax.io · 650-741-1085 · ModernTax, Inc.</span>
</p>
`.trim();

  const html = createEmailTemplate(
    '$239.94 in free credits',
    content,
    { text: 'Place your first order →', url: orderUrl },
  );

  // Plain-text fallback
  const text = `Hi ${recipientName || 'there'},

Your ModernTax account has $239.94 in free credits waiting — that covers your first 3 transcript verifications at no cost. The credit is shared across your whole team, so anyone (you or a teammate) can be the one to place that first order.

Place your first order: ${orderUrl}

Takes about 30 seconds. Pick the path that fits — upload a CSV for a batch, drop a signed 8821 PDF, or type a single borrower's details directly.

Best,
Matt
matt@moderntax.io · 650-741-1085 · ModernTax, Inc.
`.trim();

  try {
    await sgMail.send({
      to: toEmail,
      from: { email: fromEmail, name: 'Matthew Parker, ModernTax' },
      subject,
      html,
      text,
      replyTo: 'matt@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send free-credit activation email:', error);
    throw error;
  }
}

/**
 * Notifies admins that a new sign-up is awaiting approval. Fires at
 * sign-up time so admins can vet the lead-qualification info and
 * either approve + assign a client, or reject. Best-effort —
 * /api/auth/signup wraps the call in a try/catch so a failed email
 * doesn't break sign-up itself.
 */
export async function sendSignupPendingApprovalNotification(
  toEmail: string,
  signup: {
    fullName: string;
    email: string;
    title: string;
    companyName: string;
    companyDomain: string;
    referralSource: string;
    useCase: string;
    useCaseOther: string | null;
    existingClientName: string | null;
  },
): Promise<void> {
  const adminUrl = `${appUrl}/admin/pending-signups`;
  const useCaseDisplay = signup.useCase === 'other'
    ? `Other — ${signup.useCaseOther || '(no description)'}`
    : signup.useCase.charAt(0).toUpperCase() + signup.useCase.slice(1);

  const subject = `New signup awaiting approval — ${signup.fullName} @ ${signup.companyName}`;
  const content = `
<p>A new sign-up is waiting for review on the ModernTax portal.</p>

<table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:18px 0;font-size:13px;">
  <tbody>
    <tr><td style="padding:6px 0;color:#6b7280;">Name</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(signup.fullName)}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280;">Email</td><td style="padding:6px 0;"><a href="mailto:${escapeAttr(signup.email)}">${escapeHtml(signup.email)}</a></td></tr>
    <tr><td style="padding:6px 0;color:#6b7280;">Title</td><td style="padding:6px 0;">${escapeHtml(signup.title)}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280;">Company</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(signup.companyName)}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280;">Domain</td><td style="padding:6px 0;font-family:monospace;">${escapeHtml(signup.companyDomain)}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280;">Use case</td><td style="padding:6px 0;">${escapeHtml(useCaseDisplay)}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280;">Found us via</td><td style="padding:6px 0;">${escapeHtml(signup.referralSource)}</td></tr>
    ${signup.existingClientName ? `<tr><td style="padding:6px 0;color:#6b7280;">Matches existing client</td><td style="padding:6px 0;color:#0d9488;font-weight:600;">${escapeHtml(signup.existingClientName)}</td></tr>` : ''}
  </tbody>
</table>

<p style="font-size:13px;color:#6b7280;">Review and approve (or reject) from the admin portal:</p>
`.trim();

  const html = createEmailTemplate('Sign-up awaiting approval', content, {
    text: 'Review pending signup →',
    url: adminUrl,
  });

  const text = `New signup awaiting approval

Name: ${signup.fullName}
Email: ${signup.email}
Title: ${signup.title}
Company: ${signup.companyName}
Domain: ${signup.companyDomain}
Use case: ${useCaseDisplay}
Found us via: ${signup.referralSource}
${signup.existingClientName ? `Matches existing client: ${signup.existingClientName}\n` : ''}
Review at: ${adminUrl}
`.trim();

  try {
    await sgMail.send({
      to: toEmail,
      from: { email: fromEmail, name: 'ModernTax Notifications' },
      subject,
      html,
      text,
      replyTo: 'matt@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send signup-pending notification:', error);
    throw error;
  }
}

/**
 * Welcome email fired when an admin approves a pending sign-up. Tells
 * the new user they're in, surfaces their assigned client, and links
 * straight to the onboarding tour.
 */
export async function sendSignupApprovedEmail(
  toEmail: string,
  recipientName: string,
  clientName: string,
): Promise<void> {
  const loginUrl = `${appUrl}/login`;
  const tourUrl = `${appUrl}/onboarding`;
  const subject = "You're in — welcome to ModernTax";

  const content = `
<p>Hi ${escapeHtml(recipientName) || 'there'},</p>

<p>Good news — your ModernTax account is approved and ready to use. You've been added to the <strong>${escapeHtml(clientName)}</strong> account.</p>

<p>Two things to do next:</p>
<ol style="padding-left:20px;line-height:1.8;">
  <li><a href="${loginUrl}" style="color:#00C48C;">Sign in to the portal</a> using the password you chose at sign-up.</li>
  <li>Take the <a href="${tourUrl}" style="color:#00C48C;">5-minute interactive tour</a> — walks you through ordering transcripts, the compliance flow, and (if you're a manager) billing setup.</li>
</ol>

<p>Your account starts with <strong>$239.94 in free transcript credits</strong> for the team — enough for your first 3 IRS pulls at no cost.</p>

<p>Questions? Reply to this email and it lands directly in my inbox.</p>

<p style="font-size:14px;color:#1f2937;margin-top:20px;">
  Best,<br>
  Matthew Parker<br>
  <span style="color:#6b7280;font-size:12px;">matt@moderntax.io · 650-741-1085 · ModernTax, Inc.</span>
</p>
`.trim();

  const html = createEmailTemplate("You're in", content, { text: 'Sign in to the portal', url: loginUrl });

  const text = `Hi ${recipientName || 'there'},

Your ModernTax account is approved. You've been added to ${clientName}.

Sign in: ${loginUrl}
Take the 5-minute tour: ${tourUrl}

Your account starts with $239.94 in free transcript credits — enough for 3 free IRS pulls.

Reply with any questions.

Best,
Matt
matt@moderntax.io · 650-741-1085 · ModernTax, Inc.
`.trim();

  try {
    await sgMail.send({
      to: toEmail,
      from: { email: fromEmail, name: 'Matthew Parker, ModernTax' },
      subject,
      html,
      text,
      replyTo: 'matt@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send approval welcome email:', error);
    throw error;
  }
}

/**
 * Invoice Breakdown Email
 *
 * Mercury sends the formal invoice with the pay button. This is the
 * follow-up that delivers our itemized PDF — every entity, processor, and
 * monitoring fee — alongside a recap of the total and a one-click pay link.
 *
 * Two variants:
 *   - Billed (mode='billed'): Mercury invoice exists. Email recaps total +
 *     Mercury pay link, attaches the breakdown PDF.
 *   - Trial (mode='trial'): client is on free trial — no Mercury invoice
 *     yet. Email shows what was used (PDF) and nudges them to set up
 *     Mercury billing so they don't miss a beat when the trial ends.
 *
 * The PDF is attached as application/pdf with disposition=attachment so it
 * lands as a real file download, not inline preview.
 */
export async function sendInvoiceBreakdownEmail(params: {
  to: string;
  cc?: string[];
  clientName: string;
  invoiceNumber: string;        // "INV-2026-04-CENT" or trial preview pseudo-number
  billingPeriodStart: string;   // "2026-04-01"
  billingPeriodEnd: string;     // "2026-04-30"
  totalAmount: number;          // dollars
  totalEntities: number;
  pdfBytes: Uint8Array;
  pdfFilename: string;          // "ModernTax-INV-2026-04-CENT.pdf"
  mode: 'billed' | 'trial';
  payUrl?: string;              // billed mode: Mercury pay URL
  trialBillingSetupUrl?: string;// trial mode: portal billing setup
  trialCreditApplied?: number;  // trial mode: how much was waived (e.g. $239.94)
}): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured - cannot send breakdown email');
    return;
  }

  const periodLabel = `${formatPeriodMonth(params.billingPeriodStart, params.billingPeriodEnd)}`;
  const fmtMoney = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  let subject: string;
  let title: string;
  let content: string;
  let cta: { text: string; url: string } | undefined;

  if (params.mode === 'billed') {
    subject = `${escapeHtml(params.clientName)} — ${periodLabel} usage breakdown (${params.invoiceNumber})`;
    title = `${periodLabel} Detailed Breakdown`;
    content = `
<p>Hi there,</p>
<p>Thanks for the business this month. Mercury just delivered <strong>${escapeHtml(params.invoiceNumber)}</strong> via separate email — this follow-up is the itemized breakdown for your records.</p>
<table style="width:100%; border-collapse:collapse; margin:20px 0; background:#f8fafc; border:1px solid #e2e8f0; border-radius:6px;">
  <tr><td style="padding:10px 14px; border-bottom:1px solid #e2e8f0;"><strong>Billing period</strong></td><td style="padding:10px 14px; border-bottom:1px solid #e2e8f0; text-align:right;">${escapeHtml(periodLabel)}</td></tr>
  <tr><td style="padding:10px 14px; border-bottom:1px solid #e2e8f0;"><strong>Items</strong></td><td style="padding:10px 14px; border-bottom:1px solid #e2e8f0; text-align:right;">${params.totalEntities}</td></tr>
  <tr><td style="padding:10px 14px;"><strong>Total due</strong></td><td style="padding:10px 14px; text-align:right; font-size:18px; color:#0a1929;"><strong>${fmtMoney(params.totalAmount)}</strong></td></tr>
</table>
<p>The full breakdown is attached as <code>${escapeHtml(params.pdfFilename)}</code>: every entity, who processed it, when it completed, plus monitoring activity.</p>
<p style="font-size:13px; color:#666;"><strong>Tip:</strong> Mercury supports auto-pay enrollment from the pay page — one-click setup means no more chasing due dates. Saves both of us time.</p>
<p>Anything off? Reply to this email and I'll fix it before payment processes.</p>
    `.trim();
    if (params.payUrl) {
      cta = { text: `Pay ${fmtMoney(params.totalAmount)} via Mercury →`, url: params.payUrl };
    }
  } else {
    // Trial mode
    subject = `${escapeHtml(params.clientName)} — ${periodLabel} usage recap (Trial Credit applied)`;
    title = `${periodLabel} Usage Summary`;
    const credited = params.trialCreditApplied || params.totalAmount;
    content = `
<p>Hi there,</p>
<p>Quick recap of what your team ran through ModernTax in ${escapeHtml(periodLabel)}. Per our agreement, your <strong>Trial Credit covers this period in full</strong> — nothing is owed this month. Going forward you'll be billed on the 1st of each month for the prior month's usage, Net 15 via ACH through Mercury.</p>
<table style="width:100%; border-collapse:collapse; margin:20px 0; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:6px;">
  <tr><td style="padding:10px 14px; border-bottom:1px solid #bbf7d0;"><strong>Billing period</strong></td><td style="padding:10px 14px; border-bottom:1px solid #bbf7d0; text-align:right;">${escapeHtml(periodLabel)}</td></tr>
  <tr><td style="padding:10px 14px; border-bottom:1px solid #bbf7d0;"><strong>Verifications completed</strong></td><td style="padding:10px 14px; border-bottom:1px solid #bbf7d0; text-align:right;">${params.totalEntities}</td></tr>
  <tr><td style="padding:10px 14px; border-bottom:1px solid #bbf7d0;"><strong>Usage at contracted rate</strong></td><td style="padding:10px 14px; border-bottom:1px solid #bbf7d0; text-align:right;">${fmtMoney(credited)}</td></tr>
  <tr><td style="padding:10px 14px; border-bottom:1px solid #bbf7d0;"><strong>Trial Credit applied</strong></td><td style="padding:10px 14px; border-bottom:1px solid #bbf7d0; text-align:right; color:#15803d;">−${fmtMoney(credited)}</td></tr>
  <tr><td style="padding:10px 14px;"><strong>Owed this month</strong></td><td style="padding:10px 14px; text-align:right; font-size:18px; color:#15803d;"><strong>$0.00</strong></td></tr>
</table>
<p>The full itemized breakdown is attached as <code>${escapeHtml(params.pdfFilename)}</code> — every entity, who processed it, when it completed.</p>
<div style="background:#fffbeb; border:1px solid #fcd34d; border-radius:6px; padding:16px 20px; margin:24px 0;">
  <p style="margin:0 0 10px 0; font-size:15px;"><strong>Action: Set up automated ACH billing for May usage onward.</strong></p>
  <p style="margin:0 0 10px 0; font-size:14px; color:#444;">Your June 1 invoice will be your first paid bill (covering May usage). To enroll in Mercury auto-pay now so you never have to think about it again, please reply to this email and I'll send a one-click enrollment link tailored to your account. Takes 60 seconds — saves us both the AR back-and-forth.</p>
  <p style="margin:0; font-size:13px; color:#666;">Prefer to wait and enroll on the first invoice? Mercury's pay page has a "Save payment method" checkbox at checkout — same outcome.</p>
</div>
<p>Anything off in the breakdown? Reply here and I'll dig in.</p>
    `.trim();
    cta = {
      text: 'Reply to enroll in Mercury auto-pay',
      url: 'mailto:matt@moderntax.io?subject=Enroll%20Statewide%20CDC%20in%20Mercury%20auto-pay',
    };
  }

  const html = createEmailTemplate(title, content, cta);

  // SendGrid expects base64 string for binary attachments.
  const pdfBase64 = Buffer.from(params.pdfBytes).toString('base64');

  try {
    await sgMail.send({
      to: params.to,
      cc: (params.cc && params.cc.length > 0) ? params.cc : undefined,
      from: fromEmail,
      subject,
      html,
      replyTo: 'matt@moderntax.io',
      attachments: [{
        content: pdfBase64,
        filename: params.pdfFilename,
        type: 'application/pdf',
        disposition: 'attachment',
      }],
    });
  } catch (error) {
    console.error('Failed to send invoice breakdown email:', error);
    throw error;
  }
}

/**
 * Notify Matt that someone (anonymous prospect OR a logged-in admin) has
 * requested the $1,000 IRS check-reissue service. Mercury ACH is the
 * billing path — Matt manually creates the invoice in the Mercury
 * dashboard and Mercury sends the customer the pay-by-ACH email.
 *
 * Two callsites:
 *   1. /api/billing/check-reissue-request (anonymous, from /sample-transcripts/erc-report)
 *      — `source: 'public_sample'`, no entity_id, no portal account yet.
 *   2. /api/admin/check-reissue (authenticated admin, from /admin/erc-report/[entityId])
 *      — `source: 'admin_portal'`, has entity context.
 *
 * Always sends to matt@moderntax.io regardless of which environment we're
 * running in — this is an internal ops notification, not a customer email.
 */
export async function sendCheckReissueRequestNotification(opts: {
  source: 'public_sample' | 'admin_portal';
  /** Customer's reply-able email (where to send the Mercury ACH invoice). */
  customerEmail: string;
  /** Customer's business name (recipient name on the Mercury invoice). */
  businessName: string;
  /** Refund context — quarter / amount / notes. All optional. */
  refundContext?: {
    quarter?: string;       // e.g. "2020 Q4"
    refundAmount?: number;  // dollars
    refundDate?: string | null;
    returnedDate?: string | null;
    ein?: string | null;
    notes?: string | null;
  };
  /** Set when the request was created from inside the portal — link back. */
  internalContext?: {
    checkReissueId: string;
    entityId: string;
    entityName?: string;
    clientName?: string;
    requestedByEmail?: string;
  };
}): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('[sendCheckReissueRequestNotification] SENDGRID_API_KEY not set — skipping');
    return;
  }

  const fmtMoney = (n?: number) =>
    typeof n === 'number'
      ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '—';

  const sourceLabel = opts.source === 'public_sample'
    ? 'Public ERC sample (anonymous prospect)'
    : 'Admin ERC report (logged-in user)';

  const ctx = opts.refundContext || {};
  const internal = opts.internalContext;

  const refundRows = [
    ctx.quarter ? `<tr><td style="padding:6px 0;color:#6b7280;">Quarter</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(ctx.quarter)}</td></tr>` : '',
    ctx.refundAmount ? `<tr><td style="padding:6px 0;color:#6b7280;">Original refund</td><td style="padding:6px 0;font-weight:600;">${fmtMoney(ctx.refundAmount)}</td></tr>` : '',
    ctx.refundDate ? `<tr><td style="padding:6px 0;color:#6b7280;">Issued</td><td style="padding:6px 0;">${escapeHtml(ctx.refundDate)}</td></tr>` : '',
    ctx.returnedDate ? `<tr><td style="padding:6px 0;color:#6b7280;">Returned undelivered</td><td style="padding:6px 0;">${escapeHtml(ctx.returnedDate)}</td></tr>` : '',
    ctx.ein ? `<tr><td style="padding:6px 0;color:#6b7280;">EIN</td><td style="padding:6px 0;font-family:monospace;">${escapeHtml(ctx.ein)}</td></tr>` : '',
    ctx.notes ? `<tr><td style="padding:6px 0;color:#6b7280;vertical-align:top;">Notes</td><td style="padding:6px 0;white-space:pre-wrap;">${escapeHtml(ctx.notes)}</td></tr>` : '',
  ].filter(Boolean).join('');

  const internalBlock = internal ? `
<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:6px;padding:12px 16px;margin:16px 0;font-size:13px;">
  <p style="margin:0 0 6px;color:#1e3a5f;font-weight:600;">Internal context</p>
  <p style="margin:0;">
    Entity: <strong>${escapeHtml(internal.entityName || internal.entityId)}</strong><br>
    ${internal.clientName ? `Client: ${escapeHtml(internal.clientName)}<br>` : ''}
    ${internal.requestedByEmail ? `Requested by: ${escapeHtml(internal.requestedByEmail)}<br>` : ''}
    Reissue request id: <code>${escapeHtml(internal.checkReissueId)}</code><br>
    <a href="${appUrl}/admin/erc-report/${escapeAttr(internal.entityId)}" style="color:#2563eb;">Open ERC report →</a>
  </p>
</div>` : '';

  const subject = `[Check Reissue · Mercury ACH] $1,000 — ${opts.businessName}`;
  const content = `
<p><strong>${sourceLabel}</strong> just requested the IRS Check Reissue service.</p>

<table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;margin:18px 0;font-size:13px;">
  <tbody>
    <tr><td style="padding:6px 0;color:#6b7280;width:140px;">Business</td><td style="padding:6px 0;font-weight:600;">${escapeHtml(opts.businessName)}</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280;">Email</td><td style="padding:6px 0;"><a href="mailto:${escapeAttr(opts.customerEmail)}">${escapeHtml(opts.customerEmail)}</a></td></tr>
    <tr><td style="padding:6px 0;color:#6b7280;">Service fee</td><td style="padding:6px 0;font-weight:600;">$1,000.00</td></tr>
    <tr><td style="padding:6px 0;color:#6b7280;">Billing</td><td style="padding:6px 0;font-weight:600;color:#0369a1;">Mercury ACH (manual invoice)</td></tr>
    ${refundRows}
  </tbody>
</table>

${internalBlock}

<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:6px;padding:14px 18px;margin:20px 0;">
  <p style="margin:0 0 6px;font-weight:700;color:#92400e;">Next step — create Mercury ACH invoice</p>
  <ol style="margin:0;padding-left:20px;font-size:13px;color:#78350f;">
    <li>Open Mercury → <strong>Send invoice</strong></li>
    <li>Recipient: <code>${escapeHtml(opts.customerEmail)}</code> (${escapeHtml(opts.businessName)})</li>
    <li>Amount: <strong>$1,000.00</strong> · Memo: "IRS check reissue recovery service${ctx.quarter ? ` — ${escapeHtml(ctx.quarter)}` : ''}"</li>
    <li>Once paid: file Form 8822-B + call IRS Business &amp; Specialty Tax line</li>
  </ol>
</div>
`.trim();

  const html = createEmailTemplate('Check Reissue Requested', content);

  try {
    await sgMail.send({
      to: 'matt@moderntax.io',
      from: { email: fromEmail, name: 'ModernTax Notifications' },
      subject,
      html,
      replyTo: opts.customerEmail,  // Reply lands in the customer's inbox
    });
  } catch (error) {
    console.error('[sendCheckReissueRequestNotification] SendGrid error:', error);
    // Don't throw — caller should still treat the request as accepted even
    // if email delivery fails. The DB row + audit log preserves the request.
  }
}

/**
 * Manual-signature 8821 fallback — used when Dropbox Sign returns 402
 * payment_required (free tier blocked from production signatures).
 *
 * Generates the 8821 PDF server-side via lib/8821-pdf, attaches it to
 * a SendGrid email, and instructs the signer to print/sign/fax-back
 * OR email-back the signed copy. The portal team picks up the signed
 * copy via existing inbound channels (the +1 415-900-4436 fax already
 * routes to ModernTax's inbox).
 *
 * Why this exists: Centerstone had 7 entities stuck in `pending` on
 * 2026-05-13 because the inline sendSignatureRequest() call returns
 * 402 from Dropbox Sign on the free tier. We need to keep moving until
 * the Dropbox Sign paid plan is funded — this email-only flow does
 * exactly that.
 */
export async function send8821ManualSignatureEmail(opts: {
  signerEmail: string;
  signerName: string;
  entityName: string;
  formType: string;
  /** Pre-generated 8821 PDF as a Buffer or Uint8Array. */
  pdfBytes: Uint8Array | Buffer;
  /** Reference id (entity id) included in the email + filename. */
  entityId: string;
}): Promise<void> {
  if (!sendGridApiKey) {
    throw new Error('SENDGRID_API_KEY not set — cannot send manual signature email');
  }

  const faxNumber = '+1 (415) 900-4436';
  const subject = `Action required: sign Form 8821 for ${opts.entityName}`;
  const fileSafe = opts.entityName.replace(/[^a-zA-Z0-9]+/g, '_');
  const pdfFilename = `Form-8821-${fileSafe}.pdf`;
  const pdfBase64 = Buffer.from(opts.pdfBytes).toString('base64');

  const content = `
<p>Hi ${escapeHtml(opts.signerName)},</p>

<p>We need your signature on a Form 8821 (Tax Information Authorization) so we can pull
IRS tax transcripts for <strong>${escapeHtml(opts.entityName)}</strong> on your behalf —
this is the standard authorization SBA lenders require to verify tax history before
funding a loan.</p>

<p><strong>Attached</strong> is the pre-filled Form 8821. We need it signed and returned
within 5 business days. Two ways to return it (pick whichever is easier):</p>

<div style="background-color:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:20px;margin:24px 0;">
  <p style="font-weight:700;font-size:16px;margin:0 0 12px 0;color:#0369a1;">Option A — Email back (easiest)</p>
  <ol style="margin:0 0 0 0;padding-left:20px;">
    <li style="margin-bottom:6px;">Print the attached <code>${escapeHtml(pdfFilename)}</code></li>
    <li style="margin-bottom:6px;">Sign on the &ldquo;Signature&rdquo; line in Section 7 (wet ink — pen on paper)</li>
    <li style="margin-bottom:6px;">Scan or take a photo of the signed form</li>
    <li>Reply to <strong>this email</strong> with the signed copy attached</li>
  </ol>
</div>

<div style="background-color:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:20px;margin:24px 0;">
  <p style="font-weight:700;font-size:16px;margin:0 0 12px 0;color:#92400e;">Option B — Fax back</p>
  <p style="margin:0 0 8px 0;">Sign the printed form, then fax to:</p>
  <div style="background:#fff;border:2px solid #92400e;border-radius:6px;padding:14px;text-align:center;">
    <p style="font-size:22px;font-weight:700;color:#92400e;margin:0;">${faxNumber}</p>
    <p style="font-size:13px;color:#92400e;margin:4px 0 0 0;">ATTN: ModernTax 8821 — ${escapeHtml(opts.entityName)}</p>
  </div>
  <p style="font-size:12px;color:#78350f;margin:8px 0 0 0;">No fax machine? Use a free service like <a href="https://faxzero.com" style="color:#92400e;">FaxZero</a> or a mobile scanning app (CamScanner, Adobe Scan).</p>
</div>

<p style="font-size:14px;color:#333;"><strong>What we&apos;ll do once we receive it:</strong> we&apos;ll
submit the signed 8821 to the IRS Practitioner Priority Service and pull your transcripts.
Typical turnaround once signed: <strong>24 to 48 hours</strong>.</p>

<p style="font-size:13px;color:#666;margin-top:24px;">Reference: <code>${escapeHtml(opts.entityId)}</code>${opts.formType ? ' · Form ' + escapeHtml(opts.formType) : ''}<br>
Questions? Reply to this email or contact <a href="mailto:support@moderntax.io" style="color:#00C48C;">support@moderntax.io</a>.</p>
`.trim();

  const html = createEmailTemplate('Sign Form 8821', content);

  await sgMail.send({
    to: opts.signerEmail,
    from: { email: fromEmail, name: 'ModernTax' },
    subject,
    html,
    replyTo: 'support@moderntax.io',
    attachments: [{
      content: pdfBase64,
      filename: pdfFilename,
      type: 'application/pdf',
      disposition: 'attachment',
    }],
  });
}

/**
 * Notify client managers when a monitoring re-pull surfaces a MATERIAL
 * variance in income figures vs. the loan-approval baseline.
 *
 * Fired by lib/income-monitoring-hook.captureEntityIncome() — only when
 * any of gross_receipts / total_income / total_tax / AGI moves >15% vs.
 * the baseline captured at first pull (or, for funded loans, at loan
 * approval time). Smaller variances stay in-app on the compliance
 * status page and don't trigger an email.
 *
 * Driver: Enterprise Bank (Derek Le, 2026-05-11) ask — "income monitoring
 * for when the bank follows up on the filing of business/personal tax
 * return post loan funding to reconcile to the information provided
 * for loan approval."
 */
export async function sendIncomeVarianceAlert(opts: {
  recipients: string[];
  entityName: string;
  clientName: string;
  entityId: string;
  variance: any; // ReconciliationResult — typed loosely to avoid cyclical import with lib/income-reconciliation
}): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('[sendIncomeVarianceAlert] SENDGRID_API_KEY not set — skipping');
    return;
  }

  const v = opts.variance;
  const fmtMoney = (n: number | null) =>
    typeof n === 'number'
      ? `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : '—';
  const fmtPct = (p: number | null) =>
    typeof p === 'number'
      ? `${p > 0 ? '+' : ''}${(p * 100).toFixed(1)}%`
      : '—';
  const sevColor = (s: string) =>
    s === 'MATERIAL' ? '#dc2626' : s === 'WARNING' ? '#d97706' : '#6b7280';
  const fieldLabel = (f: string) =>
    f === 'grossReceipts' ? 'Gross receipts' :
    f === 'totalIncome' ? 'Total income' :
    f === 'totalTax' ? 'Total tax' :
    f === 'agi' ? 'AGI' : f;

  const rows = v.fields
    .filter((f: any) => f.severity !== 'INFO')
    .map((f: any) => `<tr>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;">${fieldLabel(f.field)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-family:monospace;">${fmtMoney(f.baseline)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-family:monospace;">${fmtMoney(f.current)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-family:monospace;color:${sevColor(f.severity)};font-weight:600;">${fmtPct(f.deltaPct)}</td>
      <td style="padding:8px 12px;border-bottom:1px solid #eee;"><span style="background:${sevColor(f.severity)}15;color:${sevColor(f.severity)};padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;">${f.severity}</span></td>
    </tr>`).join('\n');

  const content = `
<p>A monitoring re-pull on <strong>${escapeHtml(opts.entityName)}</strong> (${escapeHtml(opts.clientName)}) surfaced a <strong style="color:#dc2626;">MATERIAL variance</strong> in income figures vs. the baseline captured at loan approval.</p>

<p style="font-size:14px;color:#1a1a1a;">${escapeHtml(v.summary)}</p>

<table style="width:100%;border-collapse:collapse;font-size:13px;margin:16px 0;border:1px solid #eee;border-radius:6px;overflow:hidden;">
  <thead>
    <tr style="background:#f9f9f9;">
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #00C48C;">Field</th>
      <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #00C48C;">Baseline (${escapeHtml(v.baseline.taxYear || '?')})</th>
      <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #00C48C;">Current (${escapeHtml(v.current.taxYear || '?')})</th>
      <th style="padding:8px 12px;text-align:right;border-bottom:2px solid #00C48C;">Δ</th>
      <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #00C48C;">Severity</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<p><strong>Why this matters:</strong> Material variance between the loan-approval income figures and the most-recent IRS-filed return is a reconciliation flag. Common causes: amended return, missed reporting, business performance change. SBA loan servicing typically requires a written explanation from the borrower for variance &gt;15%.</p>

<p><strong>Open the full report:</strong> <a href="${appUrl}/admin/compliance-status/${escapeAttr(opts.entityId)}" style="color:#00C48C;font-weight:600;">View compliance status for ${escapeHtml(opts.entityName)}</a></p>

<p style="font-size:13px;color:#666;margin-top:24px;">Baseline source: ${escapeHtml(v.baseline.source || 'first pull')}, captured ${escapeHtml(v.baseline.capturedAt?.slice(0, 10) || 'unknown')}.<br>Current source: ${escapeHtml(v.current.source || 'this pull')}, captured ${escapeHtml(v.current.capturedAt?.slice(0, 10) || 'unknown')}.</p>
`.trim();

  const html = createEmailTemplate(`Income variance alert — ${opts.entityName}`, content, {
    text: 'View compliance status report',
    url: `${appUrl}/admin/compliance-status/${opts.entityId}`,
  });

  try {
    await sgMail.send({
      to: opts.recipients,
      from: { email: fromEmail, name: 'ModernTax Notifications' },
      subject: `[Income Variance — MATERIAL] ${opts.entityName} (${opts.clientName})`,
      html,
      replyTo: 'matt@moderntax.io',
    });
  } catch (error) {
    console.error('[sendIncomeVarianceAlert] SendGrid error:', error);
  }
}

/** "2026-04-01" + "2026-04-30" → "April 2026". Falls back to range form. */
function formatPeriodMonth(start: string, end: string): string {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const [sy, sm] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  if (sy === ey && sm === em) return `${months[sm - 1]} ${sy}`;
  return `${months[(sm || 1) - 1]} ${sy} – ${months[(em || 1) - 1]} ${ey}`;
}

// Tiny HTML escapers to keep user-supplied strings safe in our templates.
function escapeHtml(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s: string | null | undefined): string {
  return escapeHtml(s);
}

// ---------------------------------------------------------------------------
// Calendar invite delivery
// ---------------------------------------------------------------------------

/**
 * Send a calendar invite (.ics) as a proper meeting email so Gmail/Outlook
 * detect it inline (with "Yes / Maybe / No" buttons) instead of treating it
 * as a generic attachment.
 *
 * The two SendGrid mechanics that make inline detection work:
 *   1. Two `content` parts on the message — text/html (the human-readable
 *      preamble) AND text/calendar; method=REQUEST (the actual invite).
 *      Gmail uses the second part to render the inline event card.
 *   2. ALSO attach the same ICS as a .ics file attachment so Outlook +
 *      mobile clients that don't parse the multipart body still get it.
 *
 * Returns the SendGrid message id on success; throws on API error.
 */
export async function sendCalendarInvite(opts: {
  to: { email: string; name?: string };
  subject: string;
  htmlPreamble: string;
  ics: string;
  method: 'REQUEST' | 'CANCEL';
  /** Optional CC list — typically matt@moderntax.io for visibility. */
  cc?: string[];
}): Promise<string> {
  if (!sendGridApiKey) {
    console.warn('[sendCalendarInvite] SENDGRID_API_KEY not set — skipping');
    return 'skipped';
  }

  const icsBase64 = Buffer.from(opts.ics, 'utf8').toString('base64');

  // SendGrid's v3 API rejects MIME type parameters (";" in the type string)
  // on both `content` parts and `attachments` — that's the magic header Gmail
  // looks for to render inline RSVP buttons (`text/calendar; method=REQUEST`).
  // SendGrid validation strips it: 400 "The content type cannot contain ';'".
  //
  // What still works across every major client when sent as a plain
  // text/calendar attachment:
  //   • Apple Mail / iCloud Mail → auto-detects the .ics, surfaces "Add to
  //                                Calendar" inline in the message
  //   • Outlook (web/desktop)    → recognizes by extension, shows event card
  //   • Gmail                    → shows .ics as a normal attachment with an
  //                                "Add to calendar" link on click
  //
  // For native Gmail inline RSVP buttons we'd need a direct SMTP path that
  // allows MIME parameters; deferred — the attachment-based flow already
  // gets the event onto the recipient's calendar with one click everywhere.
  const msg: any = {
    to: opts.to.name ? { email: opts.to.email, name: opts.to.name } : opts.to.email,
    cc: opts.cc?.length ? opts.cc : undefined,
    from: { email: fromEmail, name: 'ModernTax' },
    subject: opts.subject,
    html: opts.htmlPreamble,
    attachments: [
      {
        filename: opts.method === 'CANCEL' ? 'cancel.ics' : 'invite.ics',
        type: 'text/calendar',
        disposition: 'attachment',
        content: icsBase64,
      },
    ],
  };

  const [response] = await sgMail.send(msg);
  return response.headers?.['x-message-id'] || 'sent';
}

// =============================================================================
// ERC Check Reissue — Engagement Emails
// =============================================================================

interface ErcIntakeKickoffArgs {
  toEmail: string;
  toName: string;
  entityName: string;
  totalRecoverable: number;
  intakeUrl: string;
  trackingUrl: string;
  quarters: { taxQuarter: string; amount: number; issuedDate: string }[];
}

/**
 * Sent to the merchant CEO/authorized officer right after the engagement is
 * created. Pairs with the Mercury invoice email — invoice handles payment,
 * this handles the data we need (new address, Form 3911 cert box, sig).
 */
export async function sendErcIntakeKickoff(args: ErcIntakeKickoffArgs): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured — cannot send ERC intake kickoff');
    return;
  }
  const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const quartersRows = args.quarters.map(q =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;">${q.taxQuarter}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">issued ${q.issuedDate}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:600;">${usd(q.amount)}</td></tr>`,
  ).join('');

  const content = `
<p>Hi ${args.toName.split(' ')[0] || 'there'},</p>

<p>Great connecting today. As discussed, here's everything queued up to reclaim <strong>${usd(args.totalRecoverable)}</strong> in returned ERC refund checks for ${args.entityName}:</p>

<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:14px;">
  <thead>
    <tr style="background:#f5f5f5;">
      <th style="padding:8px 12px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#666;">Quarter</th>
      <th style="padding:8px 12px;text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#666;">Status</th>
      <th style="padding:8px 12px;text-align:right;font-size:12px;text-transform:uppercase;letter-spacing:0.5px;color:#666;">Amount</th>
    </tr>
  </thead>
  <tbody>${quartersRows}</tbody>
  <tfoot>
    <tr style="background:#f5f5f5;">
      <td style="padding:8px 12px;font-weight:600;">Total recoverable</td>
      <td></td>
      <td style="padding:8px 12px;text-align:right;font-weight:700;color:#00C48C;">${usd(args.totalRecoverable)}</td>
    </tr>
  </tfoot>
</table>

<p><strong>Two next steps from you:</strong></p>
<ol>
  <li>Pay the Mercury invoice (sent separately) — covers the recovery bundle + both check reissues.</li>
  <li>Fill out the intake form below — takes 2 minutes. We need your new mailing address (the first checks were returned because the IRS address on file is stale) and a quick Form 3911 signature.</li>
</ol>

<p>Both steps done before Monday morning = our expert calls the IRS Business &amp; Specialty Tax Line at 7 AM ET to initiate the refund trace. Replacement checks typically land in 3–6 weeks for returned checks.</p>

<p><strong>You'll be able to track every step at this link:</strong><br>
<a href="${args.trackingUrl}" style="color:#00C48C;">${args.trackingUrl}</a></p>

<p>We email you on every status change. Reply to this email anytime — I'm in the inbox daily.</p>

<p style="margin-top:24px;">— Matt</p>
  `.trim();

  const html = createEmailTemplate(
    `${args.entityName} — ERC refund recovery is in motion`,
    content,
    { text: 'Complete intake form (2 min)', url: args.intakeUrl },
  );

  try {
    await sgMail.send({
      to: args.toEmail,
      from: { email: fromEmail, name: 'Matt Parker · ModernTax' },
      subject: `${args.entityName} — ${usd(args.totalRecoverable)} ERC refund recovery: next steps`,
      html,
      replyTo: 'matt@moderntax.io',
      categories: ['marketing_erc_kickoff'],
    });
  } catch (error) {
    console.error('Failed to send ERC intake kickoff email:', error);
    throw error;
  }
}

interface ErcAdminIntakeReceivedArgs {
  adminEmail: string;
  entityName: string;
  entityId: string;
  officer: { name: string; title: string; signatureDate: string };
  newMailingAddress: {
    address1: string;
    address2?: string;
    city: string;
    state: string;
    zip: string;
  };
  quarters: { taxQuarter: string; certificationBox: number | null }[];
  additionalNotes: string;
}

/**
 * Sent to the admin (Matt) the moment a merchant submits the intake form.
 * Cue for the expert to schedule the IRS call for the next business morning.
 */
export async function sendErcAdminIntakeReceived(args: ErcAdminIntakeReceivedArgs): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid API key not configured — cannot send ERC admin intake notification');
    return;
  }
  const addr = args.newMailingAddress;
  const quartersList = args.quarters.map(q =>
    `<li><strong>${q.taxQuarter}</strong> — Form 3911 Section III Box ${q.certificationBox ?? '?'}</li>`,
  ).join('');
  const content = `
<p><strong>Merchant just completed the intake form.</strong> Time to schedule the IRS Business &amp; Specialty Tax Line call.</p>

<p><strong>Entity:</strong> ${args.entityName}<br>
<strong>Entity ID:</strong> <code>${args.entityId}</code></p>

<p><strong>New mailing address (use this to update the IRS, not the 8821 address):</strong></p>
<blockquote style="border-left:3px solid #00C48C;padding-left:12px;margin:8px 0;color:#444;">
  ${addr.address1}${addr.address2 ? '<br>' + addr.address2 : ''}<br>
  ${addr.city}, ${addr.state} ${addr.zip}
</blockquote>

<p><strong>Authorized officer:</strong> ${args.officer.name} (${args.officer.title}), signed ${args.officer.signatureDate}</p>

<p><strong>Quarters to reissue:</strong></p>
<ul>${quartersList}</ul>

${args.additionalNotes ? `<p><strong>Additional notes from merchant:</strong></p><blockquote style="border-left:3px solid #999;padding-left:12px;margin:8px 0;color:#444;">${args.additionalNotes}</blockquote>` : ''}

<p>Call 1-800-829-4933 at 7 AM ET tomorrow business morning. Have ready: EIN, address (above), exact dollar amounts per quarter, Form 941 filing details, authorized officer info.</p>
  `.trim();

  const html = createEmailTemplate(
    `ERC intake received: ${args.entityName}`,
    content,
    { text: 'Open admin view', url: `${appUrl}/admin/compliance-status/${args.entityId}` },
  );

  try {
    await sgMail.send({
      to: args.adminEmail,
      from: fromEmail,
      subject: `[ERC] Intake received — ${args.entityName} ready for IRS call`,
      html,
      replyTo: 'matt@moderntax.io',
    });
  } catch (error) {
    console.error('Failed to send ERC admin intake notification:', error);
    // Non-blocking — don't throw
  }
}

// =============================================================================
// ERC Recovery — stage update email (fires on every admin-driven stage advance)
// =============================================================================

interface ErcStageUpdateArgs {
  toEmail: string;
  toName?: string | null;
  entityName: string;
  stageLabel: string;        // e.g., "Refund trace filed"
  stageMerchantCopy: string; // canned per-stage explanation from STAGES[]
  customNote?: string | null;// optional admin-written note for this specific transition
  trackingUrl: string;
}

/**
 * Sent to the merchant every time admin advances the engagement to a new
 * stage. Pulls the canned per-stage copy from STAGES[] and optionally an
 * admin-written note (e.g., "trace confirmation #IRS-2026-0517-3344").
 */
export async function sendErcStageUpdate(args: ErcStageUpdateArgs): Promise<void> {
  if (!sendGridApiKey) {
    console.warn('SendGrid not configured — skipping ERC stage update email');
    return;
  }
  const firstName = (args.toName || '').trim().split(/\s+/)[0] || 'there';
  const content = `
<p>Hi ${firstName},</p>

<p>Status update on the ERC refund recovery for <strong>${args.entityName}</strong>:</p>

<div style="background:#D1FAE5;border-left:4px solid #10B981;padding:14px 18px;margin:16px 0;border-radius:4px;">
  <div style="font-weight:700;color:#065F46;font-size:16px;margin-bottom:4px;">${args.stageLabel}</div>
  <div style="color:#1a1a1a;font-size:14px;">${args.stageMerchantCopy}</div>
</div>

${args.customNote ? `<p><strong>From your case manager:</strong></p><blockquote style="border-left:3px solid #00C48C;padding-left:12px;margin:8px 0;color:#444;font-style:italic;">${args.customNote}</blockquote>` : ''}

<p>Full timeline + all updates always live at your status page:</p>
<p style="text-align:center;margin:20px 0;">
  <a href="${args.trackingUrl}" style="display:inline-block;background-color:#00C48C;color:#ffffff;padding:12px 26px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">View status page →</a>
</p>

<p>Reply to this email or text Matt if you have any questions.</p>
<p style="margin-top:24px;">— Matt</p>
  `.trim();

  const html = createEmailTemplate(`${args.entityName} — ${args.stageLabel}`, content, undefined);

  try {
    await sgMail.send({
      to: args.toEmail,
      from: { email: fromEmail, name: 'Matt Parker · ModernTax' },
      subject: `${args.entityName} — ${args.stageLabel}`,
      html,
      replyTo: 'matt@moderntax.io',
      categories: ['transactional_erc_stage_update'],
    });
  } catch (error) {
    console.error('Failed to send ERC stage update email:', error);
  }
}
