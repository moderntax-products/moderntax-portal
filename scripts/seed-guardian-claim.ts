/**
 * Seed a demo claims-verification "bundle" for the Guardian Life demo:
 * one claim (request) with multiple parties — the insured, spouse (joint 1040),
 * and their K-1 business — each with realistic Wage & Income data, so the
 * earned-vs-passive split + Excel export show compelling numbers live.
 *
 * Targets an EXISTING client by slug (account creation is done in the admin UI):
 *   CLIENT_SLUG=guardian npx -y dotenv-cli -e .env.local -e .env.vercel-prod -- npx tsx scripts/seed-guardian-claim.ts
 * Defaults to a sandbox for a safe dry-run.
 */
import { createClient } from '@supabase/supabase-js';

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const SLUG = process.env.CLIENT_SLUG || 'vine-sandbox';
const f = (k: string, v: number) => ({ [k]: v });

// One bundle: John (insured, 1040 + K-1) + Jane (spouse, 1040) + Acme (1065 business).
const PARTIES = [
  {
    entity_name: 'John A. Sample', tid: '412-55-7788', tid_kind: 'SSN', form_type: '1040',
    income: [
      { form_type: 'W-2', payer_name: 'NORTHSTAR ENGINEERING INC', tax_year: '2024', fields: f('Wages, tips, other compensation', 180000) },
      { form_type: '1099-INT', payer_name: 'FIRST NATIONAL BANK', tax_year: '2024', fields: f('Interest Income', 4200) },
      { form_type: '1099-DIV', payer_name: 'VANGUARD BROKERAGE', tax_year: '2024', fields: { 'Total Ordinary Dividends': 11500, 'Qualified Dividends': 8200 } },
      { form_type: '1099-B', payer_name: 'VANGUARD BROKERAGE', tax_year: '2024', fields: f('Proceeds', 22000) },
      { form_type: 'Schedule K-1 (1065)', payer_name: 'ACME HOLDINGS LLC', tax_year: '2024', fields: f('Ordinary Business Income', 65000) },
      { form_type: 'W-2', payer_name: 'NORTHSTAR ENGINEERING INC', tax_year: '2023', fields: f('Wages, tips, other compensation', 172000) },
    ],
  },
  {
    entity_name: 'Jane M. Sample', tid: '401-22-9911', tid_kind: 'SSN', form_type: '1040',
    income: [
      { form_type: 'W-2', payer_name: 'MERCY REGIONAL HOSPITAL', tax_year: '2024', fields: f('Wages, tips, other compensation', 95000) },
      { form_type: 'W-2', payer_name: 'MERCY REGIONAL HOSPITAL', tax_year: '2023', fields: f('Wages, tips, other compensation', 91000) },
    ],
  },
  {
    entity_name: 'Acme Holdings LLC', tid: '88-1234567', tid_kind: 'EIN', form_type: '1065',
    income: [], // business return pulled for the 8821/transcript; its income flows to John's K-1 above
  },
];

async function main() {
  const { data: client } = await admin.from('clients').select('id, name').eq('slug', SLUG).single() as { data: any };
  if (!client) { console.error(`No client with slug "${SLUG}". Create it in the admin UI first.`); process.exit(1); }
  let { data: prof } = await admin.from('profiles').select('id').eq('client_id', client.id).in('role', ['manager', 'processor']).limit(1).maybeSingle() as { data: any };
  if (!prof) {
    // requested_by is NOT NULL — fall back to any admin (fine for a sandbox dry-run).
    const { data: a } = await admin.from('profiles').select('id').eq('role', 'admin').limit(1).maybeSingle() as { data: any };
    prof = a;
  }
  if (!prof) { console.error('No usable profile for requested_by.'); process.exit(1); }
  console.log(`Seeding demo claim for ${client.name} (${SLUG})`);

  const loan = `CLAIM-DEMO-${String(Date.now()).slice(-5)}`;
  const { data: req, error: rErr } = await admin.from('requests').insert({
    client_id: client.id, requested_by: prof?.id || null, loan_number: loan,
    intake_method: 'manual', product_type: 'claims_verification', status: 'completed',
  } as any).select('id').single() as { data: any; error: any };
  if (rErr) { console.error('request insert failed:', rErr.message); process.exit(1); }

  for (const p of PARTIES) {
    const years = [...new Set(p.income.map(i => String(i.tax_year)))].sort();
    const { error: eErr } = await admin.from('request_entities').insert({
      request_id: req.id, entity_name: p.entity_name, tid: p.tid, tid_kind: p.tid_kind,
      form_type: p.form_type, years: years.length ? years : ['2024'], status: 'completed',
      gross_receipts: { product_type: 'claims_verification', claims_income_sources: p.income },
    } as any);
    console.log(`  ${eErr ? '❌ ' + eErr.message : '✅'} ${p.entity_name} (${p.form_type}, ${p.income.length} income sources)`);
  }

  console.log(`\nClaim ${loan} seeded → request ${req.id}`);
  console.log(`Excel export: GET /api/admin/claims-income-export?requestId=${req.id}`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
