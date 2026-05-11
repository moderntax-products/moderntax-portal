/**
 * Inspect what we have for Mento Technologies — the TaxTaker trial.
 * Matt says the request is complete and wants ERC analysis for 2020-
 * 2022, which means we should have 941 transcripts on file.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: ents } = await supabase
    .from('request_entities')
    .select(`
      id, entity_name, tid, form_type, years, status,
      transcript_urls, transcript_html_urls,
      gross_receipts, completed_at, updated_at,
      requests(loan_number, clients(name))
    `)
    .ilike('entity_name', '%Mento%') as { data: any[] | null };

  for (const e of ents || []) {
    console.log(`\n=== ${e.entity_name} ===`);
    console.log(`  id:            ${e.id}`);
    console.log(`  tid:           ${e.tid}`);
    console.log(`  form_type:     ${e.form_type}`);
    console.log(`  years:         ${JSON.stringify(e.years)}`);
    console.log(`  status:        ${e.status}`);
    console.log(`  client:        ${(e as any).requests?.clients?.name}`);
    console.log(`  loan:          ${(e as any).requests?.loan_number}`);
    console.log(`  completed_at:  ${e.completed_at || '—'}`);
    console.log(`  updated_at:    ${e.updated_at}`);
    console.log(`  transcript_urls (${(e.transcript_urls || []).length}):`);
    (e.transcript_urls || []).forEach((u: string) => console.log(`    - ${u}`));
    console.log(`  transcript_html_urls (${(e.transcript_html_urls || []).length}):`);
    (e.transcript_html_urls || []).forEach((u: string) => console.log(`    - ${u}`));

    // Sample one transcript to confirm content
    const sample = (e.transcript_html_urls || []).find((u: string) => u.endsWith('.html')) ||
                   (e.transcript_urls || []).find((u: string) => u.endsWith('.html'));
    if (sample) {
      console.log(`\n  --- Sampling ${sample} ---`);
      const { data: file } = await supabase.storage.from('uploads').download(sample);
      if (file) {
        const text = Buffer.from(await file.arrayBuffer()).toString('utf8');
        const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 800);
        console.log(`  Text snippet: ${plain}`);
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
