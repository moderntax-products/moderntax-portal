/**
 * Check the designee on the Mento Technologies 8821 — was it
 * LaTonya / Matt (our experts) or a TaxTaker / external practitioner?
 *
 * The filename "TaxTaker Authorization for IRS Communication_f8821_Mento.pdf"
 * could imply either:
 *   (a) TaxTaker-branded template signed for one of OUR experts as
 *       designee → fine to bundle with other LaTonya-designated entities
 *   (b) TaxTaker-branded template signed for a TaxTaker employee as
 *       designee → CAN'T bundle with LaTonya's other entities; needs
 *       its own call from a different expert
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Pull the Mento entity row to confirm 8821 path + any designee field
  const { data: ent } = await supabase
    .from('request_entities')
    .select('*')
    .eq('id', 'f92264b1-d420-4865-93f0-33943fc507ff')
    .single() as { data: any };
  if (!ent) { console.log('Mento entity not found'); return; }
  console.log(`Entity: ${ent.entity_name}  signed_8821: ${ent.signed_8821_url}`);

  if (!ent.signed_8821_url) { console.log('No 8821 on file'); return; }

  // Download + parse
  const { data: file } = await supabase.storage.from('uploads').download(ent.signed_8821_url);
  if (!file) { console.log('Download failed'); return; }
  const buf = Buffer.from(await file.arrayBuffer());

  const pdfParse = (await import('pdf-parse')).default;
  const parsed = await pdfParse(buf);
  const text = parsed.text;

  // Look for the designee section (Form 8821 Section 2)
  const designeeIdx = text.search(/Designee/i);
  if (designeeIdx >= 0) {
    console.log('\n=== Designee section (next 800 chars) ===');
    console.log(text.slice(designeeIdx, designeeIdx + 800));
  }

  // CAF / PTIN extraction
  const cafs = text.match(/CAF\s*(?:No|Number)?[:.\s]*([0-9]{4}-[0-9]{5}[A-Z]?)/gi) || [];
  const ptins = text.match(/PTIN[:.\s]*([P]?[0-9]{7,9})/gi) || [];
  console.log('\nCAFs found in form:', cafs);
  console.log('PTINs found in form:', ptins);

  // Designee names — look for known patterns
  const ourPractitioners = ['LaTonya', 'Holmes', 'Matthew Parker', 'Matt Parker'];
  for (const name of ourPractitioners) {
    if (text.toLowerCase().includes(name.toLowerCase())) {
      console.log(`✓ Form mentions "${name}" — likely OUR designee`);
    }
  }

  // Look for any TaxTaker employee name on the designee line
  if (text.toLowerCase().includes('taxtaker')) {
    console.log('⚠ Form contains "TaxTaker" — verify whether it\'s just the borrower\'s side or the designee');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
