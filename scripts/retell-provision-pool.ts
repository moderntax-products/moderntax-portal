/**
 * Provision the 4-timezone outbound number pool for IRS PPS calls.
 *
 * Buys one Retell-managed phone number per US timezone (ET/CT/MT/PT),
 * assigns each to the ModernTax IRS PPS Agent, and prints a ready-to-paste
 * RETELL_PHONE_POOL env var for Vercel.
 *
 * Prereqs:
 *   1. A card on file at https://dashboard.retellai.com/billing
 *      (Retell rejects /create-phone-number with 402 otherwise)
 *   2. scripts/retell-setup.ts has already run so RETELL_IRS_AGENT_ID is set
 *
 * Cost: 4 × $2/mo = $8/mo infrastructure. Pays back ~10x on first day of
 * expanded calling window.
 *
 * Re-run safe: if a timezone already has a number assigned to our agent,
 * it's reused instead of buying a duplicate.
 */
import * as fs from 'fs';
for (const fname of ['.env.local']) {
  if (!fs.existsSync(fname)) continue;
  const envFile = fs.readFileSync(fname, 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

import { createPhoneNumber, listPhoneNumbers } from '../lib/retell';

interface PoolTarget {
  tz: string;
  area_codes: number[];  // try these in order — Retell picks what's available
  label: string;
}

const TARGETS: PoolTarget[] = [
  { tz: 'America/New_York',   area_codes: [212, 646, 332, 917, 718], label: 'NY-ET' },
  { tz: 'America/Chicago',    area_codes: [312, 773, 872, 224, 847], label: 'Chicago-CT' },
  { tz: 'America/Denver',     area_codes: [303, 720, 970, 602, 480], label: 'Denver-MT' },
  { tz: 'America/Los_Angeles', area_codes: [415, 628, 310, 213, 818], label: 'SF-PT' },
];

async function main() {
  const AGENT_ID = process.env.RETELL_IRS_AGENT_ID;
  if (!AGENT_ID) throw new Error('RETELL_IRS_AGENT_ID not set — run scripts/retell-setup.ts first');

  const existing = await listPhoneNumbers();
  console.log(`Existing Retell phone numbers: ${existing.length}`);
  for (const p of existing) {
    console.log(`  ${p.phone_number_pretty || p.phone_number}  outbound=${p.outbound_agent_id || '—'}  ${p.nickname || '—'}`);
  }

  const pool: { phone: string; tz: string; area_code?: number; label: string }[] = [];

  for (const target of TARGETS) {
    // Reuse if we already have a number assigned to our agent with this tz label
    const reuse = existing.find(p =>
      p.outbound_agent_id === AGENT_ID &&
      (p.nickname || '').includes(target.label)
    );
    if (reuse) {
      const area = parseInt(reuse.phone_number.replace(/\D/g, '').slice(1, 4), 10);
      console.log(`✓ Reusing ${reuse.phone_number} for ${target.label}`);
      pool.push({ phone: reuse.phone_number, tz: target.tz, area_code: area, label: target.label });
      continue;
    }

    // Buy a new number, trying area codes in priority order
    let bought = null;
    for (const areaCode of target.area_codes) {
      try {
        console.log(`→ Buying ${target.label} number in area code ${areaCode}…`);
        bought = await createPhoneNumber({
          area_code: areaCode,
          outbound_agent_id: AGENT_ID,
          nickname: `ModernTax IRS ${target.label}`,
        });
        console.log(`  ✓ got ${bought.phone_number}`);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('402')) {
          console.error('  ✗ Retell requires a card on file. Add one at https://dashboard.retellai.com/billing and re-run.');
          return;
        }
        console.error(`  ✗ area ${areaCode} failed: ${msg.slice(0, 120)} — trying next…`);
      }
    }
    if (!bought) {
      console.error(`✗ No area code available for ${target.label}. Skipping.`);
      continue;
    }
    pool.push({
      phone: bought.phone_number,
      tz: target.tz,
      area_code: target.area_codes.find(ac => bought!.phone_number.includes(String(ac))),
      label: target.label,
    });
  }

  console.log('\n=== RETELL_PHONE_POOL (paste into Vercel env) ===');
  console.log(`RETELL_PHONE_POOL='${JSON.stringify(pool)}'`);
  console.log('\nThen set CALL_PROVIDER=retell and redeploy.');
}

main().catch(err => {
  console.error('FAIL:', err instanceof Error ? err.message : err);
  process.exit(1);
});
