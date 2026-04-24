/**
 * One-off CLI to set an expert's SSN + DOB directly (bypassing the HTTP
 * endpoint). Useful for the first expert before the profile UI is live.
 *
 * Usage:
 *   EXPERT_EMAIL=matthewaparker@icloud.com \
 *   EXPERT_SSN=XXX-XX-XXXX \
 *   EXPERT_DOB=MM/DD/YYYY \
 *   npx tsx scripts/set-expert-credentials.ts
 *
 * Env required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * EXPERT_CREDENTIALS_KEY (from .env.local).
 *
 * After running:
 *   • Profile is updated with encrypted SSN + DOB + consent timestamp.
 *   • audit_log gets an irs_credentials_updated row.
 *   • SSN/DOB never hit disk in plaintext — only the encrypted blobs.
 *
 * To run ad-hoc without leaking credentials into shell history, prefix
 * with a space on bash (HISTCONTROL=ignorespace) or use zsh histignorespace.
 */

import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

for (const fname of ['.env.local']) {
  if (!fs.existsSync(fname)) continue;
  const envFile = fs.readFileSync(fname, 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

import { encryptCredential, normalizeSSN, normalizeDOB } from '../lib/crypto';

async function main() {
  const email = process.env.EXPERT_EMAIL;
  const ssn = process.env.EXPERT_SSN;
  const dob = process.env.EXPERT_DOB;

  if (!email || !ssn || !dob) {
    console.error('Usage: EXPERT_EMAIL=... EXPERT_SSN=... EXPERT_DOB=... npx tsx scripts/set-expert-credentials.ts');
    process.exit(1);
  }

  const ssnClean = normalizeSSN(ssn);
  const dobClean = normalizeDOB(dob);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  // Find the expert's profile by email
  const list = await supabase.auth.admin.listUsers();
  const user = list.data?.users?.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
  if (!user) throw new Error(`No auth user found with email=${email}`);

  const { data: profile } = await supabase
    .from('profiles')
    .select('id, role, email, full_name')
    .eq('id', user.id)
    .single();
  if (!profile) throw new Error(`No profile row for ${email}`);
  if ((profile as any).role !== 'expert') {
    console.warn(`⚠ Profile role is "${(profile as any).role}", not "expert". Proceeding anyway.`);
  }

  const now = new Date().toISOString();
  const { error } = await (supabase.from('profiles' as any) as any)
    .update({
      ssn_encrypted: encryptCredential(ssnClean),
      dob_encrypted: encryptCredential(dobClean),
      irs_credentials_updated_at: now,
      irs_credentials_consented_at: now,
    })
    .eq('id', user.id);

  if (error) {
    if (error.message.includes('column') && error.message.includes('does not exist')) {
      console.error('\n❌ The ssn_encrypted / dob_encrypted columns do not exist yet.');
      console.error('   Run this SQL in Supabase SQL Editor first:');
      console.error('   supabase/migration-expert-irs-credentials.sql\n');
      process.exit(1);
    }
    throw error;
  }

  // Audit log — cast because audit_log isn't in generated types.
  await (supabase.from('audit_log' as any) as any).insert({
    user_email: user.email,
    action: 'irs_credentials_updated',
    entity_type: 'profile',
    entity_id: user.id,
    details: {
      set_via: 'scripts/set-expert-credentials.ts',
      consented: true,
      // Safe to log: non-reversible fingerprints.
      ssn_fingerprint: require('crypto').createHash('sha256').update(ssnClean).digest('hex').slice(0, 8),
      dob_fingerprint: require('crypto').createHash('sha256').update(dobClean).digest('hex').slice(0, 8),
    },
  });

  console.log(`✓ Credentials set for ${email} (profile ${user.id})`);
  console.log(`  updated_at:   ${now}`);
  console.log(`  consented_at: ${now}`);
  console.log(`\nNext IRS PPS call initiated for this expert will pass SSN+DOB as dynamic variables.`);
}

main().catch(err => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
