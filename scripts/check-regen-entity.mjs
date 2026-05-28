import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const ENTITY_ID = '3b165227-305a-4e74-84f3-408576dbf870';

const { data: ent } = await sb.from('request_entities')
  .select('id, entity_name, status, signed_8821_url, expert_regenerated_8821_url, requests(loan_number, clients(name))')
  .eq('id', ENTITY_ID).single();

console.log(`Entity:  ${ent?.entity_name}`);
console.log(`Client:  ${ent?.requests?.clients?.name}`);
console.log(`Loan:    ${ent?.requests?.loan_number}`);
console.log(`Status:  ${ent?.status}`);
console.log(`\nsigned_8821_url (borrower-signed, original):`);
console.log(`  ${ent?.signed_8821_url || '(none)'}`);
console.log(`\nexpert_regenerated_8821_url (the new one):`);
console.log(`  ${ent?.expert_regenerated_8821_url || '(none)'}`);

// Generate a signed URL so Matt can open it directly
if (ent?.expert_regenerated_8821_url) {
  const { data: signed } = await sb.storage.from('uploads')
    .createSignedUrl(ent.expert_regenerated_8821_url, 3600);
  console.log(`\n1-hour signed view URL:`);
  console.log(signed?.signedUrl);
}

// List ALL regen'd PDFs ever generated for this entity (storage history)
const { data: list } = await sb.storage.from('uploads').list(`8821/${ENTITY_ID}`, { limit: 50 });
console.log(`\nAll PDFs in 8821/${ENTITY_ID.slice(0,8)}/ folder:`);
for (const f of list || []) {
  console.log(`  · ${f.name} (${f.metadata?.size || '?'} bytes, ${f.created_at?.slice(0,16)})`);
}
