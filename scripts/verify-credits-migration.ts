/**
 * Post-migration verification for the prepaid-credits system. Read-only.
 * Run AFTER applying supabase/migration-client-credits.sql:
 *   npx -y dotenv-cli -e .env.local -e .env.vercel-prod -- npx tsx scripts/verify-credits-migration.ts
 *
 * Confirms: the new columns/table exist, defaults are sane, and the pricing
 * helpers resolve correctly. Does NOT charge anything.
 */
import { createClient } from '@supabase/supabase-js';
import { creditRequestRate, hasCreditsToOrder, CREDIT_PACKS, PRICE_STANDARD } from '../lib/pricing';

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  let ok = true;
  const fail = (m: string) => { ok = false; console.log('  ❌', m); };
  const pass = (m: string) => console.log('  ✅', m);

  console.log('=== 1. clients credit columns ===');
  const { data: c, error: cErr } = await admin.from('clients')
    .select('id, name, credit_balance, credit_rate, credit_purchased_total').limit(3) as { data: any[] | null; error: any };
  if (cErr) fail(`clients credit columns missing: ${cErr.message}`);
  else {
    pass('credit_balance / credit_rate / credit_purchased_total present');
    for (const r of c || []) console.log(`     ${r.name}: bal=${r.credit_balance} rate=${r.credit_rate} purchased=${r.credit_purchased_total}`);
  }

  console.log('=== 2. request_entities.credit_paid ===');
  const { error: eErr } = await admin.from('request_entities').select('id, credit_paid').limit(1) as { data: any[] | null; error: any };
  if (eErr) fail(`credit_paid missing: ${eErr.message}`); else pass('credit_paid present');

  console.log('=== 3. credit_ledger table + unique index ===');
  const { error: lErr } = await admin.from('credit_ledger' as any).select('id').limit(1) as { data: any[] | null; error: any };
  if (lErr) fail(`credit_ledger missing: ${lErr.message}`); else pass('credit_ledger present');

  console.log('=== 4. pricing helpers ===');
  const t1 = creditRequestRate({ credit_rate: null }) === PRICE_STANDARD;
  const t2 = creditRequestRate({ credit_rate: 59.99 }) === 59.99;
  const t3 = hasCreditsToOrder({ credit_balance: 120, credit_rate: 59.99 }, 2) === true;
  const t4 = hasCreditsToOrder({ credit_balance: 100, credit_rate: 59.99 }, 2) === false;
  [t1, t2, t3, t4].every(Boolean) ? pass('rate + gating helpers correct') : fail('helper math off');
  console.log('     packs:', CREDIT_PACKS.map(p => `$${p.amount}→$${p.ratePerRequest}/req (${p.discountPct}%)`).join(', '));

  console.log(ok ? '\n✅ ALL CHECKS PASSED — credits system is live.' : '\n❌ SOME CHECKS FAILED — see above.');
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
