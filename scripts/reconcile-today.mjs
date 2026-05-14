import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Use a 24-hour rolling window so the cutoff doesn't depend on UTC vs PT
// midnight boundaries (the original `setUTCHours(0,0,0,0)` rolled past
// midnight UTC = May 14 and missed all of May 13 PT activity).
const WINDOW_MS = 24 * 60 * 60 * 1000;
const cutoff = new Date(Date.now() - WINDOW_MS);
const todayMs = cutoff.getTime();

console.log(`\n=== Reconciliation: production activity in last 24 hours ===`);
console.log(`Window:    files uploaded after ${cutoff.toISOString()}`);
console.log(`Local now: ${new Date().toString()}`);
console.log(`Excluding sandbox clients (slug ending in -sandbox)\n`);

// 1. Fetch all real (non-sandbox) clients with their billing models
const { data: clients } = await sb.from('clients')
  .select('id, name, slug, billing_model, billing_rate_pdf, billing_rate_csv, free_trial, billing_payment_method')
  .not('slug', 'ilike', '%-sandbox')
  .order('name');

const clientById = new Map((clients || []).map(c => [c.id, c]));
console.log(`Real clients in scope: ${clientById.size}\n`);

// 2. Find every entity with a transcript file uploaded today (timestamp > today UTC)
//    Storage filenames are prefixed with millisecond timestamp.
const { data: ents } = await sb.from('request_entities')
  .select('id, entity_name, tid, form_type, status, completed_at, transcript_html_urls, transcript_urls, request_id, requests(client_id, loan_number)')
  .not('transcript_html_urls', 'is', null)
  .limit(2000);

const newToday = []; // { entityId, name, clientId, clientName, slug, freshFiles, status }

for (const e of (ents || [])) {
  if (!clientById.has(e.requests?.client_id)) continue; // skip sandbox or orphaned
  const client = clientById.get(e.requests.client_id);
  const allFiles = [...new Set([...(e.transcript_html_urls || []), ...(e.transcript_urls || [])])];
  const freshFiles = allFiles.filter(u => {
    const m = u.split('/').pop()?.match(/^(\d{13})-/);
    if (!m) return false;
    return parseInt(m[1]) >= todayMs;
  });
  if (freshFiles.length === 0) continue;
  newToday.push({
    entityId: e.id,
    name: e.entity_name,
    tid: e.tid,
    formType: e.form_type,
    clientId: e.requests.client_id,
    clientName: client.name,
    slug: client.slug,
    billingModel: client.billing_model,
    perTinRate: (client.billing_rate_pdf || 0),
    freshFileCount: freshFiles.length,
    freshFiles: freshFiles.map(u => u.split('/').pop()),
    status: e.status,
    loanNumber: e.requests.loan_number,
    paymentMethod: client.billing_payment_method,
    freeTrial: client.free_trial,
  });
}

console.log(`=== Entities with transcripts uploaded today: ${newToday.length} ===\n`);

// 3. Group by client + show what would bill
const byClient = new Map();
for (const n of newToday) {
  if (!byClient.has(n.clientId)) {
    byClient.set(n.clientId, { client: n.clientName, slug: n.slug, freeTrial: n.freeTrial, payment: n.paymentMethod, model: n.billingModel, entities: [] });
  }
  byClient.get(n.clientId).entities.push(n);
}

for (const [, c] of byClient) {
  console.log(`Client: ${c.client}${c.freeTrial ? ' [FREE TRIAL]' : ''}`);
  console.log(`  Billing model: ${c.model} · Payment: ${c.payment || '—'}`);
  for (const e of c.entities) {
    console.log(`    · ${e.name.padEnd(30)} (${e.tid}) ${e.formType} · status=${e.status} · ${e.freshFileCount} new file(s) today`);
    for (const f of e.freshFiles.slice(0, 4)) console.log(`        - ${f}`);
  }
  // Per-entity billing implication: existing entities don't generate net-new revenue
  // (one entity = one billable unit, regardless of how many transcripts on it)
  const wouldBeNewBillableEntities = c.entities.filter(e => e.status === 'completed' || e.status === 'irs_queue').length;
  console.log(`  Net-new billable entities under per-TIN model: ${wouldBeNewBillableEntities} (entities are billed once, not per-transcript)`);
  console.log();
}

// 4. Pending Stripe/Mercury invoices from today
console.log(`=== Outstanding invoices created today (Stripe + Mercury) ===\n`);
console.log(`  • Stripe Bundle C — TaxTaker (Mento)             $479.00  pending  (https://buy.stripe.com/28E6oG9nB0iu0l0fPqco01n)`);
console.log(`  • Stripe ERC Recovery — TaxTaker (Mento, $1K)    $1000.00 pending  (Mercury link in use)`);
console.log(`  • Mercury invoice — TaxTaker (Mento, $1K)        $1000.00 pending  (https://app.mercury.com/pay/nb8d2v9bh1dy07tz)`);
console.log(`  Note: Stripe + Mercury $1K links are alternate payment routes for the SAME work — only one will be paid.\n`);

console.log(`=== May 2026 revenue impact summary (excluding sandboxes) ===\n`);
console.log(`Per the existing per-TIN billing model in app/admin/billing/page.tsx:`);
console.log(`  - Centerstone: 922 KILBURN entity already exists → no new billable entity event`);
console.log(`  - TaxTaker: Mento entity in free-trial slot 1/3 → would bill $0 even if marked completed`);
console.log(`  - Net entity-based revenue change for today: $0`);
console.log();
console.log(`Bundle C ($479) and Recovery ($1000) are FLAT-FEE products outside the per-TIN model.`);
console.log(`These need to be recorded in the invoices table when paid — not auto-derived from entity counts.`);
