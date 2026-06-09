/**
 * Register provisioned Twilio DIDs (voice + SMS) into the callback_numbers pool.
 *
 *   NUMBERS="+13045551234,+13045555678" npx -y dotenv-cli -e .env.local -e .env.vercel-prod -- npx tsx scripts/register-callback-numbers.ts
 *
 * Idempotent (upsert on phone_number). Sets status='available'. Apply
 * migration-callback-numbers.sql first.
 */
import { createClient } from '@supabase/supabase-js';

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  const nums = (process.env.NUMBERS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!nums.length) { console.error('Set NUMBERS="+1...,+1..." (E.164).'); process.exit(1); }
  const bad = nums.filter(n => !/^\+1\d{10}$/.test(n));
  if (bad.length) { console.error('Not valid E.164 US numbers:', bad); process.exit(1); }

  for (const phone_number of nums) {
    const { error } = await admin.from('callback_numbers' as any)
      .upsert({ phone_number, provider: 'twilio', voice_enabled: true, sms_enabled: true, status: 'available' } as any,
        { onConflict: 'phone_number' });
    console.log(`  ${error ? '❌ ' + error.message : '✅'} ${phone_number}`);
  }
  const { count } = await admin.from('callback_numbers' as any).select('id', { count: 'exact', head: true }).eq('status', 'available') as { count: number | null };
  console.log(`\nPool now has ${count} available number(s).`);
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
