/**
 * POST /api/admin/send-feature-update
 *
 * Admin-triggered broadcast of the Spring 2026 feature-update email
 * to managers + processors (optionally also admins). Role-aware copy
 * via lib/sendgrid.sendFeatureUpdateEmail.
 *
 * Hard safety rails:
 *   - Admin-only auth (role === 'admin').
 *   - dry_run defaults to TRUE — caller must explicitly pass false to
 *     actually send. Dry-run returns the recipient list so the admin
 *     can eyeball who would be hit before pulling the trigger.
 *   - Only emails users with a non-null email + role in
 *     ('manager', 'processor', 'admin') by default. Pass
 *     include_admins=false to skip admins (default true since admins
 *     also benefit from seeing the changes summary).
 *   - Sends in batches of 5 with a 250ms gap between batches to stay
 *     under SendGrid burst limits and to keep the per-call response time
 *     reasonable for the admin's browser.
 *   - Records a single audit_log row per call (not per recipient) with
 *     the dry_run flag, total recipients, and success/error counts.
 *
 * Body: {
 *   dry_run?: boolean,        // default true
 *   include_admins?: boolean, // default true
 *   target_emails?: string[], // optional override — send only to these specific addresses (still subject to role filter)
 * }
 *
 * Returns: { dry_run, recipients, sent, failed, errors? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { sendFeatureUpdateEmail } from '@/lib/sendgrid';

export const maxDuration = 60;

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 250;

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, email, full_name')
    .eq('id', user.id)
    .single() as { data: { role: string; email: string; full_name: string | null } | null; error: any };

  if (!profile || profile.role !== 'admin') {
    return NextResponse.json({ error: 'Admin-only' }, { status: 403 });
  }

  const body = await request.json().catch(() => ({} as any));
  const dryRun: boolean = body.dry_run !== false; // default TRUE
  const includeAdmins: boolean = body.include_admins !== false; // default TRUE
  const targetEmails: string[] | undefined = Array.isArray(body.target_emails) && body.target_emails.length > 0
    ? body.target_emails.map((e: string) => String(e).toLowerCase().trim()).filter(Boolean)
    : undefined;

  const admin = createAdminClient();

  // Pull recipient list — manager + processor (+ admin if include_admins)
  const allowedRoles = ['manager', 'processor'];
  if (includeAdmins) allowedRoles.push('admin');

  const { data: profiles, error: profilesErr } = await (admin
    .from('profiles' as any) as any)
    .select('id, email, full_name, role')
    .in('role', allowedRoles)
    .not('email', 'is', null);

  if (profilesErr) {
    return NextResponse.json({ error: 'Failed to load recipients', detail: profilesErr.message }, { status: 500 });
  }

  // Optional whitelist
  let recipients = (profiles || []) as { id: string; email: string; full_name: string | null; role: string }[];
  if (targetEmails) {
    const allowedSet = new Set(targetEmails);
    recipients = recipients.filter(r => allowedSet.has(r.email.toLowerCase().trim()));
  }

  // Dedupe by email (just in case there are duplicate profile rows)
  const seen = new Set<string>();
  recipients = recipients.filter(r => {
    const key = r.email.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Dry run — return who WOULD be emailed, send nothing
  if (dryRun) {
    return NextResponse.json({
      dry_run: true,
      recipients: recipients.length,
      breakdown_by_role: recipients.reduce((acc: Record<string, number>, r) => {
        acc[r.role] = (acc[r.role] || 0) + 1;
        return acc;
      }, {}),
      sample_recipients: recipients.slice(0, 10).map(r => ({ email: r.email, name: r.full_name, role: r.role })),
      message: `DRY RUN — no emails sent. Re-call with {"dry_run": false} to actually broadcast.`,
    });
  }

  // Actually send — batched
  let sent = 0;
  let failed = 0;
  const errors: { email: string; error: string }[] = [];

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async r => {
        try {
          await sendFeatureUpdateEmail(
            r.email,
            r.full_name || '',
            (r.role as 'manager' | 'processor' | 'admin'),
          );
          return { email: r.email, ok: true };
        } catch (err) {
          throw new Error(err instanceof Error ? err.message : String(err));
        }
      }),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const recipient = batch[j];
      if (result.status === 'fulfilled') {
        sent++;
      } else {
        failed++;
        errors.push({
          email: recipient.email,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    // Throttle between batches
    if (i + BATCH_SIZE < recipients.length) {
      await new Promise(res => setTimeout(res, BATCH_DELAY_MS));
    }
  }

  // Audit log — single row per broadcast
  try {
    await (admin.from('audit_log' as any) as any).insert({
      user_email: profile.email,
      action: 'feature_update_broadcast',
      entity_type: 'broadcast',
      entity_id: null,
      details: {
        triggered_by: profile.email,
        dry_run: false,
        include_admins: includeAdmins,
        target_emails_filter: targetEmails || null,
        total_recipients: recipients.length,
        sent,
        failed,
        sample_errors: errors.slice(0, 5),
        sent_at: new Date().toISOString(),
      },
    });
  } catch (auditErr) {
    console.warn('[send-feature-update] audit log insert failed:', auditErr);
  }

  return NextResponse.json({
    dry_run: false,
    recipients: recipients.length,
    sent,
    failed,
    errors: errors.length > 0 ? errors : undefined,
  });
}
