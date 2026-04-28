/**
 * One-off broadcast script: sends the free-credit activation email
 * to all manager/processor/admin users EXCEPT:
 *   - Users at clients that have already completed their trial
 *     (Centerstone, TMC, Cal Statewide)
 *   - One-off competitor exclusion: dcolvin@newitymarket.com
 *
 * Usage:
 *   npx tsx broadcast-credits.ts --dry      # preview list, send nothing
 *   npx tsx broadcast-credits.ts --send     # actually broadcast
 */

import { createClient } from '@supabase/supabase-js';
import { sendFeatureUpdateEmail } from './lib/sendgrid';

const EXCLUDED_CLIENT_SLUGS = ['centerstone', 'tmc', 'cal-statewide-cdc', 'calstatewide'];
const EXCLUDED_CLIENT_NAME_FRAGMENTS = [
  'centerstone',
  'tmc financing',
  'tmc',
  'california statewide',
  'cal statewide',
];
const EXCLUDED_EMAILS = ['dcolvin@newitymarket.com'];
const ALLOWED_ROLES = ['manager', 'processor', 'admin'];
const BATCH_SIZE = 5;
const BATCH_DELAY_MS = 250;

async function main() {
  const dryRun = process.argv.includes('--dry') || !process.argv.includes('--send');

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');

  const supa = createClient(url, key, { auth: { persistSession: false } });

  // 1. Pull all client rows so we can identify excluded client_ids
  const { data: clients, error: cErr } = await supa
    .from('clients')
    .select('id, name, slug');
  if (cErr) throw cErr;

  const excludedClientIds = new Set<string>();
  (clients || []).forEach((c: any) => {
    const slug = (c.slug || '').toLowerCase();
    const name = (c.name || '').toLowerCase();
    const slugMatch = EXCLUDED_CLIENT_SLUGS.some(s => slug === s || slug.includes(s));
    const nameMatch = EXCLUDED_CLIENT_NAME_FRAGMENTS.some(f => name.includes(f));
    if (slugMatch || nameMatch) {
      excludedClientIds.add(c.id);
      console.log(`  Excluded client: ${c.name} (slug=${c.slug})`);
    }
  });

  // 2. Pull all candidate profiles
  const { data: profiles, error: pErr } = await supa
    .from('profiles')
    .select('id, email, full_name, role, client_id')
    .in('role', ALLOWED_ROLES)
    .not('email', 'is', null);
  if (pErr) throw pErr;

  // 3. Filter
  const recipients = (profiles || [])
    .filter((p: any) => p.email && p.email.trim())
    .filter((p: any) => !EXCLUDED_EMAILS.includes(p.email.toLowerCase().trim()))
    .filter((p: any) => !p.client_id || !excludedClientIds.has(p.client_id))
    // dedupe by email
    .filter((p: any, i: number, arr: any[]) =>
      arr.findIndex(o => o.email.toLowerCase().trim() === p.email.toLowerCase().trim()) === i
    );

  // Look up client name per recipient for the preview
  const clientById = new Map<string, string>();
  (clients || []).forEach((c: any) => clientById.set(c.id, c.name));

  console.log(`\n${dryRun ? 'DRY RUN' : 'LIVE BROADCAST'} — ${recipients.length} recipients\n`);
  console.log('Breakdown by role:');
  const byRole: Record<string, number> = {};
  recipients.forEach((r: any) => { byRole[r.role] = (byRole[r.role] || 0) + 1; });
  Object.entries(byRole).forEach(([role, n]) => console.log(`  ${role}: ${n}`));

  console.log('\nRecipient list:');
  recipients.forEach((r: any) => {
    const clientName = r.client_id ? (clientById.get(r.client_id) || 'unknown') : 'no-client';
    console.log(`  [${r.role}] ${r.email}  (${r.full_name || 'no name'}) @ ${clientName}`);
  });

  if (dryRun) {
    console.log(`\nDRY RUN — no emails sent. Re-run with --send to broadcast to these ${recipients.length} recipients.`);
    return;
  }

  // 4. Send in batches
  console.log(`\nSending in batches of ${BATCH_SIZE}...\n`);
  let sent = 0;
  let failed = 0;
  const errors: { email: string; error: string }[] = [];

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map((r: any) =>
        sendFeatureUpdateEmail(
          r.email,
          r.full_name || '',
          r.role as 'manager' | 'processor' | 'admin',
        ).then(() => r.email),
      ),
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
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
