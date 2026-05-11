/**
 * Quick: download the two "Unknown - 1120 Series ... 2025" files attached
 * to Peter Geyen Inc and inspect the EIN inside so we know whose
 * actual records they are.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function main() {
  const paths = [
    'transcripts/0d40fc11-6e5e-49f0-b1bb-de95933fe35e/1776105095728-Unknown - 1120 Series Record of Account - 2025.pdf',
    'transcripts/0d40fc11-6e5e-49f0-b1bb-de95933fe35e/1776105096289-Unknown - 1120 Series Record of Account - 2025.html',
    'transcripts/0d40fc11-6e5e-49f0-b1bb-de95933fe35e/1776105339029-Unknown - 1120 Series Return Transcript - 2025.pdf',
    'transcripts/0d40fc11-6e5e-49f0-b1bb-de95933fe35e/1776105339614-Unknown - 1120 Series Return Transcript - 2025.html',
  ];
  for (const path of paths) {
    console.log(`\n=== ${path}`);
    const { data, error } = await supabase.storage.from('uploads').download(path);
    if (error || !data) { console.log('  download failed:', error?.message); continue; }
    const buf = Buffer.from(await data.arrayBuffer());
    const isPdf = path.endsWith('.pdf');
    if (isPdf) {
      const text = buf.toString('latin1');
      // Look for EIN-like patterns
      const eins = text.match(/\b\d{2}[- ]?\d{7}\b/g) || [];
      const names = text.match(/(?:Taxpayer Name|Trade Name|Business Name)[:\s]+([A-Za-z0-9 &.,'-]{4,80})/gi) || [];
      console.log(`  size: ${buf.length} bytes`);
      console.log(`  EINs found: ${Array.from(new Set(eins)).slice(0, 5).join(', ') || '—'}`);
      console.log(`  Names found: ${names.slice(0, 5).map(n => n.replace(/\s+/g, ' ')).join(' | ') || '—'}`);
    } else {
      // HTML — parse plain text
      const text = buf.toString('utf8');
      const eins = text.match(/\b\d{2}[- ]?\d{7}\b/g) || [];
      const names = text.match(/(?:Taxpayer Name|Trade Name|Business Name)[:\s]*<[^>]+>\s*([A-Za-z0-9 &.,'-]{4,80})/gi) || [];
      // Also grab any plain-text near the top
      const plain = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const snippet = plain.slice(0, 800);
      console.log(`  size: ${buf.length} bytes`);
      console.log(`  EINs found: ${Array.from(new Set(eins)).slice(0, 5).join(', ') || '—'}`);
      console.log(`  snippet: ${snippet}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
