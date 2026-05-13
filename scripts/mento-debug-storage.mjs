#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const env = Object.fromEntries(
  envText.split('\n')
    .filter(l => l && !l.trim().startsWith('#') && l.includes('='))
    .map(l => {
      const eq = l.indexOf('=');
      return [l.slice(0, eq).trim(), l.slice(eq + 1).trim().replace(/^["']|["']$/g, '')];
    })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: e } = await sb
  .from('request_entities')
  .select('transcript_html_urls, transcript_urls')
  .eq('id', 'f92264b1-d420-4865-93f0-33943fc507ff')
  .single();
console.log('Raw transcript_html_urls:');
for (const u of (e?.transcript_html_urls || [])) console.log('  ' + u);
console.log('Raw transcript_urls (PDF):');
for (const u of (e?.transcript_urls || [])) console.log('  ' + u);

// List buckets
const { data: buckets } = await sb.storage.listBuckets();
console.log('\nBuckets:');
for (const b of (buckets || [])) console.log(`  ${b.id} (public=${b.public})`);

// Try downloading the 2021 transcript with different path formats
const candidates = [
  'transcripts/f92264b1-d420-4865-93f0-33943fc507ff/1778535172388-MENT TECH IN - 941 Account Transcript - 2021.html',
  'f92264b1-d420-4865-93f0-33943fc507ff/1778535172388-MENT TECH IN - 941 Account Transcript - 2021.html',
];
for (const bucket of ['transcripts', 'transcript-files', 'documents']) {
  for (const path of candidates) {
    const { data, error } = await sb.storage.from(bucket).download(path);
    console.log(`\nbucket=${bucket} path=${path}`);
    console.log(`  result: ${data ? `${data.size} bytes` : `error: ${JSON.stringify(error)}`}`);
    if (data) {
      const text = await data.text();
      console.log(`  preview: ${text.slice(0, 200)}...`);
      console.log(`  total chars: ${text.length}`);
      process.exit(0);
    }
  }
}
