/**
 * Test Email Endpoint
 * POST /api/admin/test-emails
 *
 * Fires test emails for every email type to verify SendGrid delivery.
 * All test emails go to the admin email (matt@moderntax.io).
 * Requires admin auth.
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient } from '@/lib/supabase-server';
import {
  sendPasswordResetEmail,
  sendWelcomeEmail,
  sendRequestConfirmation,
  sendCompletionNotification,
  sendDailyNudge,
  sendAdminFailureAlert,
  sendExpertAssignmentNotification,
  sendExpertCompletionNotification,
  sendSlaWarningNotification,
  sendStatusChangeNotification,
  sendExpertIssueNotification,
  sendManagerNewRequestNotification,
  sendAdminNewRequestNotification,
  sendAdminReadyFor8821Notification,
  sendAdminDailySummary,
  sendManagerWeeklySummary,
  sendProcessorWeeklySummary,
} from '@/lib/sendgrid';

const TEST_REQUEST_ID = '00000000-0000-0000-0000-000000000001';

export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerRouteClient(cookieStore);

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, email, full_name')
      .eq('id', user.id)
      .single() as { data: { role: string; email: string; full_name: string | null } | null; error: any };

    if (profile?.role !== 'admin') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const testEmail = profile.email || user.email!;
    const testName = profile.full_name || 'Test User';

    // Parse optional filter from body
    let filter: string | null = null;
    try {
      const body = await request.json();
      filter = body?.filter || null; // e.g. "admin", "processor", "expert", "manager", or specific function name
    } catch {
      // no body, run all
    }

    const results: Array<{ email_type: string; recipient_role: string; status: 'sent' | 'failed'; error?: string }> = [];

    async function tryEmail(emailType: string, recipientRole: string, fn: () => Promise<void>) {
      // Apply filter if provided
      if (filter) {
        const f = filter.toLowerCase();
        if (
          f !== recipientRole.toLowerCase() &&
          f !== emailType.toLowerCase() &&
          !emailType.toLowerCase().includes(f)
        ) {
          return;
        }
      }

      try {
        await fn();
        results.push({ email_type: emailType, recipient_role: recipientRole, status: 'sent' });
      } catch (err) {
        results.push({
          email_type: emailType,
          recipient_role: recipientRole,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ==========================================
    // 1. ADMIN EMAILS (6 types)
    // ==========================================

    await tryEmail('sendAdminNewRequestNotification', 'admin', () =>
      sendAdminNewRequestNotification(
        testEmail,
        'Jane Doe (Processor)',
        'processor',
        'Centerstone SBA Lending',
        'LOAN-TEST-001',
        3,
        TEST_REQUEST_ID
      )
    );

    await tryEmail('sendAdminFailureAlert', 'admin', () =>
      sendAdminFailureAlert(
        testEmail,
        TEST_REQUEST_ID,
        'IRS returned an error: Taxpayer not found in records for the requested tax period.'
      )
    );

    await tryEmail('sendExpertCompletionNotification', 'admin', () =>
      sendExpertCompletionNotification(
        testEmail,
        'Latonya Holmes',
        'Acme Holdings LLC (1120S)',
        TEST_REQUEST_ID
      )
    );

    await tryEmail('sendExpertIssueNotification', 'admin', () =>
      sendExpertIssueNotification(
        testEmail,
        'Latonya Holmes',
        'Smith & Partners LLC (1065)',
        'IRS system unavailable',
        'Tried 3 times today — IRS e-Services is returning 500 errors. Will retry tomorrow.',
        TEST_REQUEST_ID
      )
    );

    await tryEmail('sendAdminReadyFor8821Notification', 'admin', () =>
      sendAdminReadyFor8821Notification(
        testEmail,
        'Jane Doe',
        'Centerstone SBA Lending',
        'LOAN-TEST-001',
        [
          { entity_name: 'Acme Holdings LLC', signer_email: 'owner@acme.com' },
          { entity_name: 'Smith & Partners', signer_email: 'smith@partners.com' },
        ],
        TEST_REQUEST_ID
      )
    );

    await tryEmail('sendAdminDailySummary', 'admin', () =>
      sendAdminDailySummary(
        testEmail,
        {
          new_requests_today: 12,
          completions_today: 8,
          failures_today: 1,
          expert_completions_today: 7,
          active_requests: 34,
          expert_sla_compliance: 92,
          total_entities_completed_today: 15,
          total_entities_pending: 19,
        },
        new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
      )
    );

    // ==========================================
    // 2. PROCESSOR EMAILS (4 types)
    // ==========================================

    await tryEmail('sendWelcomeEmail_processor', 'processor', () =>
      sendWelcomeEmail(
        testEmail,
        'Jane Doe',
        'processor',
        'TempPass123!',
        'Centerstone SBA Lending'
      )
    );

    await tryEmail('sendStatusChangeNotification', 'processor', () =>
      sendStatusChangeNotification(
        testEmail,
        TEST_REQUEST_ID,
        'LOAN-TEST-001',
        'submitted',
        '8821_sent',
        'Acme Holdings LLC'
      )
    );

    await tryEmail('sendCompletionNotification', 'processor', () =>
      sendCompletionNotification(
        testEmail,
        {
          id: TEST_REQUEST_ID,
          client_id: 'test',
          requested_by: 'test',
          batch_id: null,
          loan_number: 'LOAN-TEST-001',
          intake_method: 'csv',
          product_type: 'transcript',
          external_request_token: null,
          status: 'completed',
          notes: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        },
        [
          {
            id: 'ent-1',
            request_id: TEST_REQUEST_ID,
            entity_name: 'Acme Holdings LLC',
            tid: '**-***7890',
            tid_kind: 'EIN',
            address: null, city: null, state: null, zip_code: null,
            form_type: '1120S',
            years: ['2023', '2024', '2025'],
            signer_first_name: null, signer_last_name: null, signer_email: null,
            signature_id: null, signature_created_at: null, signed_8821_url: null,
            status: 'completed',
            employment_data: null,
            gross_receipts: null,
            compliance_score: 94,
            transcript_urls: ['test.pdf'],
            completed_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ]
      )
    );

    await tryEmail('sendProcessorWeeklySummary', 'processor', () =>
      sendProcessorWeeklySummary(
        testEmail,
        testName,
        'Centerstone SBA Lending',
        {
          requests_submitted: 8,
          requests_completed: 5,
          requests_pending: 3,
          avg_turnaround_hours: 18.5,
        },
        'Mar 24 – Mar 30, 2026'
      )
    );

    // ==========================================
    // 3. EXPERT EMAILS (3 types)
    // ==========================================

    await tryEmail('sendWelcomeEmail_expert', 'expert', () =>
      sendWelcomeEmail(
        testEmail,
        'Latonya Holmes',
        'expert',
        'ExpertTemp456!'
      )
    );

    await tryEmail('sendExpertAssignmentNotification', 'expert', () =>
      sendExpertAssignmentNotification(
        testEmail,
        ['Acme Holdings LLC (1120S)', 'Smith & Partners (1065)', 'Johnson Family Trust (1040)'],
        3,
        false
      )
    );

    await tryEmail('sendExpertAssignmentNotification_employment', 'expert', () =>
      sendExpertAssignmentNotification(
        testEmail,
        ['John Doe — W2 Income Verification'],
        1,
        true
      )
    );

    await tryEmail('sendSlaWarningNotification', 'expert', () =>
      sendSlaWarningNotification(
        testEmail,
        'Acme Holdings LLC (1120S)',
        4
      )
    );

    // ==========================================
    // 4. MANAGER EMAILS (3 types)
    // ==========================================

    await tryEmail('sendWelcomeEmail_manager', 'manager', () =>
      sendWelcomeEmail(
        testEmail,
        'Sarah Johnson',
        'manager',
        'ManagerTemp789!',
        'TMC Financing'
      )
    );

    await tryEmail('sendManagerNewRequestNotification', 'manager', () =>
      sendManagerNewRequestNotification(
        testEmail,
        'Jane Doe',
        'LOAN-TEST-001',
        3,
        TEST_REQUEST_ID
      )
    );

    await tryEmail('sendManagerWeeklySummary', 'manager', () =>
      sendManagerWeeklySummary(
        testEmail,
        testName,
        'Centerstone SBA Lending',
        {
          requests_submitted: 24,
          requests_completed: 18,
          requests_failed: 2,
          entities_completed: 35,
          avg_turnaround_hours: 16.2,
          processor_breakdown: [
            { name: 'Jane Doe', submitted: 12, completed: 9 },
            { name: 'Bob Smith', submitted: 8, completed: 6 },
            { name: 'Alice Chen', submitted: 4, completed: 3 },
          ],
        },
        'Mar 24 – Mar 30, 2026'
      )
    );

    // ==========================================
    // 5. GENERAL / AUTH EMAILS (2 types)
    // ==========================================

    await tryEmail('sendPasswordResetEmail', 'any', () =>
      sendPasswordResetEmail(
        testEmail,
        testName,
        'https://portal.moderntax.io/reset-password?token=test-token-12345'
      )
    );

    await tryEmail('sendDailyNudge', 'processor', () =>
      sendDailyNudge(
        testEmail,
        {
          pending_count: 12,
          completed_count: 5,
          in_progress_count: 8,
          oldest_pending_days: 3,
        }
      )
    );

    await tryEmail('sendRequestConfirmation', 'processor', () =>
      sendRequestConfirmation(
        testEmail,
        {
          id: TEST_REQUEST_ID,
          client_id: 'test',
          requested_by: 'test',
          batch_id: null,
          loan_number: 'LOAN-TEST-001',
          intake_method: 'csv',
          product_type: 'transcript',
          external_request_token: null,
          status: 'submitted',
          notes: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: null,
        }
      )
    );

    // ==========================================
    // SUMMARY
    // ==========================================

    const sent = results.filter((r) => r.status === 'sent').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    return NextResponse.json({
      success: true,
      test_recipient: testEmail,
      summary: {
        total: results.length,
        sent,
        failed,
      },
      results,
    });
  } catch (err) {
    console.error('[test-emails] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Test emails failed' },
      { status: 500 }
    );
  }
}
