/**
 * Pull the full text of Mento's 941 Account Transcripts so we can see
 * what transaction codes / amounts are present. Drives the ERC analysis
 * library design.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs/promises';

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const paths = [
    'transcripts/f92264b1-d420-4865-93f0-33943fc507ff/1778535192848-MENT TECH IN - 941 Account Transcript - 2020.html',
    'transcripts/f92264b1-d420-4865-93f0-33943fc507ff/1778535172388-MENT TECH IN - 941 Account Transcript - 2021.html',
    'transcripts/f92264b1-d420-4865-93f0-33943fc507ff/1778535161812-MENT TECH IN - 941 Account Transcript - 2022.html',
  ];

  for (const path of paths) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(path);
    console.log('='.repeat(80));
    const { data: file } = await supabase.storage.from('uploads').download(path);
    if (!file) { console.log('Download failed'); continue; }
    const html = Buffer.from(await file.arrayBuffer()).toString('utf8');
    // Strip tags, collapse whitespace
    const text = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
    console.log(text.slice(0, 3500));
    // Also save the file locally for hand inspection
    const outPath = `/tmp/mento-${path.split(' - ')[2].replace('.html','')}.html`;
    await fs.writeFile(outPath, html);
    console.log(`\n  → saved to ${outPath}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
