/**
 * Reprice all clients to the standard $99.99 per request, EXCEPT the two
 * grandfathered legacy clients (Matt directive 2026-06-06):
 *   - Centerstone        → keep $59.98 (TR/ROA)
 *   - California Statewide → keep $79.98 (RT/ROA/CIVPEN)
 *
 * Sets both billing_rate_pdf and billing_rate_csv to 99.99 for everyone else
 * (flat $99.99 per request regardless of intake method).
 *
 * DRY_RUN=1 → report only.
 */
import { createClient } from '@supabase/supabase-js';
import { PRICE_STANDARD } from '../lib/pricing';

const DRY = process.env.DRY_RUN === '1';
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

function isGrandfathered(c: { slug?: string | null; name?: string | null }): boolean {
  const slug = (c.slug || '').toLowerCase();
  const name = (c.name || '').toLowerCase();
  if (slug === 'centerstone' || name.includes('centerstone')) return true;
  if (slug.startsWith('california-statewide') || slug.startsWith('cal-statewide') || slug === 'calstatewide') return true;
  if (name.includes('california statewide') || name.includes('cal statewide')) return true;
  return false;
}

async function main() {
  console.log(DRY ? '=== DRY RUN ===' : '=== LIVE REPRICE ===');
  const { data: clients, error } = await admin.from('clients')
    .select('id, name, slug, billing_rate_pdf, billing_rate_csv').order('name') as { data: any[] | null; error: any };
  if (error) throw error;

  let repriced = 0, kept = 0;
  for (const c of clients!) {
    if (isGrandfathered(c)) {
      console.log(`  KEEP  ${c.name}  (pdf ${c.billing_rate_pdf} / csv ${c.billing_rate_csv})`);
      kept++;
      continue;
    }
    const already = c.billing_rate_pdf === PRICE_STANDARD && c.billing_rate_csv === PRICE_STANDARD;
    console.log(`  ${already ? 'OK   ' : 'REPRICE'} ${c.name}  ${c.billing_rate_pdf}/${c.billing_rate_csv} -> ${PRICE_STANDARD}/${PRICE_STANDARD}`);
    if (already) { repriced++; continue; }
    if (!DRY) {
      const { error: e } = await admin.from('clients')
        .update({ billing_rate_pdf: PRICE_STANDARD, billing_rate_csv: PRICE_STANDARD } as any)
        .eq('id', c.id);
      if (e) { console.log(`    ERR ${e.message}`); continue; }
    }
    repriced++;
  }
  console.log(`\n${repriced} repriced to $${PRICE_STANDARD}, ${kept} grandfathered.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
