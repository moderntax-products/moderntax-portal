import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const entityId = 'f92264b1-d420-4865-93f0-33943fc507ff';
const sourcePath = '/Users/matthewparker/Downloads/110427913171-7.html';
const html = readFileSync(sourcePath, 'utf8');

// Use a clean filename consistent with the other Mento transcripts
const filename = `${Date.now()}-MENT TECH IN - 941 Account Transcript - 2021-Q4.html`;
const storagePath = `transcripts/${entityId}/${filename}`;

const { error: upErr } = await sb.storage.from('uploads').upload(storagePath, Buffer.from(html, 'utf-8'), {
  contentType: 'text/html',
  upsert: true,
});
if (upErr) {
  console.error(`Upload failed: ${upErr.message}`);
  process.exit(1);
}
console.log(`✓ Uploaded to ${storagePath}`);

// Append to the entity's transcript URLs
const { data: ent } = await sb.from('request_entities').select('transcript_html_urls, transcript_urls').eq('id', entityId).single();
const newHtml = [...(ent.transcript_html_urls || []), storagePath];
const newAny  = [...(ent.transcript_urls || []), storagePath];
await sb.from('request_entities').update({
  transcript_html_urls: newHtml,
  transcript_urls: newAny,
}).eq('id', entityId);
console.log(`✓ Appended to entity transcript_html_urls (now ${newHtml.length} files)`);
console.log(`✓ Mento Q4 2021 RSB quarter is now on file.`);
