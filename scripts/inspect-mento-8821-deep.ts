import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const path = '0faf285f-7806-4e49-8e22-7e362b2b9cd5/8821/1778525808644-TaxTaker Authorization for IRS Communication_f8821_Mento.pdf';
  const { data: file } = await supabase.storage.from('uploads').download(path);
  if (!file) { console.log('Download failed'); return; }
  const buf = Buffer.from(await file.arrayBuffer());
  const pdfParse = (await import('pdf-parse')).default;
  const parsed = await pdfParse(buf);
  console.log(`PDF size: ${buf.length} bytes  pages: ${parsed.numpages}  text chars: ${parsed.text.length}`);
  console.log('\n=== FULL TEXT ===');
  console.log(parsed.text);
}
main().catch(e => { console.error(e); process.exit(1); });
