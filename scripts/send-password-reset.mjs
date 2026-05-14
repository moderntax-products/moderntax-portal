/**
 * Trigger a Supabase password-reset email for a user, NOW.
 *
 * Driver: Katie Lent (lent@growthcorp.com) didn't receive her reset
 * email — could be SES throttling, address typo on the original
 * invite, or a stuck queue. This script re-fires via the service-role
 * admin client and prints the recovery link inline so Matt can DM it
 * to her directly if email is still slow.
 *
 * Usage:
 *   node scripts/send-password-reset.mjs <email> [redirect-path]
 *
 * Example:
 *   node scripts/send-password-reset.mjs lent@growthcorp.com /reset-password
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const email = process.argv[2];
const redirectPath = process.argv[3] || '/reset-password';
if (!email) {
  console.error('Usage: node scripts/send-password-reset.mjs <email> [redirect-path]');
  process.exit(1);
}

const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';
const redirectTo = `${appUrl}${redirectPath}`;

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// Confirm the user exists first so we get a clear error if the email is wrong
const { data: userLookup, error: lookupErr } = await sb.auth.admin.listUsers();
if (lookupErr) { console.error('listUsers failed:', lookupErr.message); process.exit(1); }
const user = userLookup.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
if (!user) {
  console.error(`✗ No auth user found for ${email}`);
  console.error('Check the email spelling, or whether the user was actually invited.');
  process.exit(1);
}
console.log(`✓ Found user: ${user.email} (id=${user.id})`);
console.log(`  Created:           ${user.created_at}`);
console.log(`  Last sign-in:      ${user.last_sign_in_at || 'NEVER'}`);
console.log(`  Email confirmed:   ${user.email_confirmed_at || 'NO'}`);

// Generate a recovery link directly via the admin API. This works even
// when SES is slow or the user's mailbox is filtering aggressively —
// we get the link back inline and can share it with the user via any
// other channel.
const { data: linkData, error: linkErr } = await sb.auth.admin.generateLink({
  type: 'recovery',
  email,
  options: { redirectTo },
});

if (linkErr) {
  console.error(`\n✗ generateLink failed: ${linkErr.message}`);
  process.exit(1);
}

console.log(`\n✓ Recovery link generated (also emailed via Supabase's transactional sender):`);
console.log(`\n  ${linkData.properties?.action_link}\n`);
console.log(`Share this link with the user directly if they don't receive the email`);
console.log(`(SES sometimes delays delivery 5-15 minutes; the link is valid for 1 hour).`);
console.log();

// Also fire the resetPasswordForEmail path — this is the SDK call the
// normal /reset-password page uses. It re-enqueues the email using the
// configured template. Belt-and-suspenders.
const { error: resetErr } = await sb.auth.resetPasswordForEmail(email, { redirectTo });
if (resetErr) {
  console.warn(`(Optional resetPasswordForEmail also failed: ${resetErr.message})`);
} else {
  console.log(`✓ resetPasswordForEmail also fired — double-coverage.`);
}
