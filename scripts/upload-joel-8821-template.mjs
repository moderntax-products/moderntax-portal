/**
 * One-off: upload Joel Abernathy's pre-filled 8821 template to Supabase
 * storage and link it on his profile. Apply migration-expert-template-8821.sql
 * BEFORE running this.
 *
 * Source file (Matt's local): /Users/matthewparker/Downloads/Joel template.pdf
 * Storage destination: uploads/expert-templates/{joel_id}.pdf
 */

import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const JOEL_EMAIL = 'joelsteven@earthlink.net';
const SOURCE_PATH = '/Users/matthewparker/Downloads/Joel template.pdf';

// 1. Find Joel's profile id
const { data: joel } = await sb.from('profiles').select('id, email, full_name').eq('email', JOEL_EMAIL).single();
if (!joel) { console.error(`✗ Profile not found for ${JOEL_EMAIL}`); process.exit(1); }
console.log(`✓ Found ${joel.full_name} <${joel.email}> id=${joel.id.slice(0,8)}`);

// 2. Read the local PDF
const pdfBuffer = await readFile(SOURCE_PATH);
console.log(`✓ Read template PDF: ${pdfBuffer.length} bytes`);

// 3. Upload to storage
const storagePath = `expert-templates/${joel.id}.pdf`;
const { error: upErr } = await sb.storage
  .from('uploads')
  .upload(storagePath, pdfBuffer, {
    contentType: 'application/pdf',
    upsert: true, // allow re-uploads if expert updates their template
  });
if (upErr) { console.error(`✗ Upload failed: ${upErr.message}`); process.exit(1); }
console.log(`✓ Uploaded to ${storagePath}`);

// 4. Link on profile
const { error: profErr } = await sb.from('profiles')
  .update({ expert_template_8821_url: storagePath })
  .eq('id', joel.id);
if (profErr) {
  if (/expert_template_8821_url|column .* does not exist|PGRST204/i.test(profErr.message || '')) {
    console.error(`✗ Column missing — run supabase/migration-expert-template-8821.sql FIRST, then re-run this script.`);
  } else {
    console.error(`✗ Profile update failed: ${profErr.message}`);
  }
  process.exit(1);
}
console.log(`✓ Linked template on ${joel.full_name}'s profile`);

console.log('\nNext run of "Regenerate 8821 w/ expert creds" for any of Joel\'s entities will use this template as the canvas.');
