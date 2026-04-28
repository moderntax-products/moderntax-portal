/**
 * Scheduled broadcast — fires once via scheduled-tasks MCP, then never
 * again. Hardcoded recipient list (option B from the 2026-04-27 chat:
 * the 5 "real" customer-facing accounts after stripping test/demo/self
 * accounts and the dcolvin competitor exclusion).
 *
 * Each recipient is looked up in profiles to pull their full_name +
 * role for the per-recipient template (role doesn't change copy in the
 * current free-credits-only template, but full_name does — "Hi Erin,"
 * vs "Hi there,").
 *
 * Usage:
 *   npx tsx broadcast-credits-am.ts --dry      # preview
 *   npx tsx broadcast-credits-am.ts --send     # actually send
 *
 * Required env (loaded from .env.local at runtime by the scheduled
 * task's shell wrapper):
 *   SENDGRID_API_KEY, SENDGRID_FROM_EMAIL,
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *   NEXT_PUBLIC_APP_URL (force to https://portal.moderntax.io)
 */

import { createClient } from '@supabase/supabase-js';
import { sendFeatureUpdateEmail } from './lib/sendgrid';

const RECIPIENT_EMAILS = [
  'erin.wilsey@bancofcal.com',
  'joaquin@useappcap.com',
  'stephen.barber@southerngracetruckingllc.com',
  'lent@growthcorp.com',
  'matt@getclearfirm.com',
];

const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 250;

async function main() {
  const dryRun = process.argv.includes('--dry') || !process.argv.includes('--send');

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

  const supa = createClient(url, key, { auth: { persistSession: false } });

  // Pull profile rows for the hardcoded list to grab full_name + role
  const { data: profiles, error } = await supa
    .from('profiles')
    .select('email, full_name, role')
    .in('email', RECIPIENT_EMAILS);
  if (error) throw error;

  // Build the send list — fall back to "there" + 'manager' role if no
  // profile row exists for an email. Logged loudly so we notice mismatches.
  const recipients = RECIPIENT_EMAILS.map(email => {
    const p = (profiles || []).find((p: any) => p.email?.toLowerCase().trim() === email.toLowerCase().trim());
    if (!p) console.warn(`  WARN: no profile found for ${email} — using fallback name/role`);
    return {
      email,
      name: p?.full_name?.trim() || '',
      role: (p?.role || 'manager') as 'manager' | 'processor' | 'admin',
    };
  });

  console.log(`\n${dryRun ? 'DRY RUN' : 'LIVE BROADCAST'} — ${recipients.length} recipients\n`);
  recipients.forEach(r => console.log(`  [${r.role}] ${r.email}  (${r.name || 'no name'})`));

  if (dryRun) {
    console.log(`\nDRY RUN — no emails sent. Re-run with --send to broadcast.`);
    return;
  }

  console.log(`\nSending in batches of ${BATCH_SIZE}...\n`);
  let sent = 0;
  let failed = 0;
  const errors: { email: string; error: string }[] = [];

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(r => sendFeatureUpdateEmail(r.email, r.name, r.role).then(() => r.email)),
    );
    results.forEach((res, idx) => {
      const r = batch[idx];
      if (res.status === 'fulfilled') {
        sent++;
        console.log(`  ✓ ${r.email}`);
      } else {
        failed++;
        const msg = res.reason instanceof Error ? res.reason.message : String(res.reason);
        errors.push({ email: r.email, error: msg });
        console.log(`  ✗ ${r.email} — ${msg}`);
      }
    });
    if (i + BATCH_SIZE < recipients.length) {
      await new Promise(res => setTimeout(res, BATCH_DELAY_MS));
    }
  }

  console.log(`\nDONE — sent ${sent}, failed ${failed}`);
  if (errors.length > 0) {
    console.log('\nErrors:');
    errors.forEach(e => console.log(`  ${e.email}: ${e.error}`));
  }
  // Hard exit non-zero if any failed so the scheduled task surfaces it
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
