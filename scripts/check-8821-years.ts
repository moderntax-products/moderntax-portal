/**
 * Download the Great Lakes Wood Co LLC 8821 PDF and grep for the
 * tax-periods section to confirm whether 2022 and 2025 are in scope.
 *
 * If years are NOT covered, we need a re-sign before any new pull.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const path = '8821/86027ead-be1d-447a-86dd-a286bf03bee1/1776271173594-signed-8821.pdf';
  const { data, error } = await supabase.storage.from('uploads').download(path);
  if (error || !data) { console.log('download failed:', error?.message); return; }
  const buf = Buffer.from(await data.arrayBuffer());
  console.log(`Downloaded ${buf.length} bytes`);

  // Try pdf-parse via dynamic import (already a dep)
  const pdfParse = (await import('pdf-parse')).default;
  const parsed = await pdfParse(buf);
  const text = parsed.text;
  console.log(`\n=== PDF text (first 4000 chars) ===\n${text.slice(0, 4000)}`);

  // Look for years explicitly
  const years = (text.match(/20\d{2}/g) || []);
  const yearCounts: Record<string, number> = {};
  years.forEach(y => yearCounts[y] = (yearCounts[y] || 0) + 1);
  console.log(`\n=== Years mentioned in 8821 ===\n${JSON.stringify(yearCounts, null, 2)}`);

  // Look for the specific tax periods / years section
  const periodsIdx = text.toLowerCase().indexOf('year(s) or period(s)');
  if (periodsIdx >= 0) {
    console.log(`\n=== Years/Periods section (next 500 chars) ===`);
    console.log(text.slice(periodsIdx, periodsIdx + 500));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
