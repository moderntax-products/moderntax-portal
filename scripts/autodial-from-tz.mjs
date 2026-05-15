/**
 * Force the autodial to use a specific phone-pool entry by passing the
 * timezone label on the command line. One process per timezone =
 * concurrent calls into different IRS call centers (PPS routes by
 * area code), maximizing the chance of catching a short-wait queue
 * or a callback-offered prompt.
 *
 * Usage:
 *   node scripts/autodial-from-tz.mjs NY-ET
 *   node scripts/autodial-from-tz.mjs Chicago-CT
 *   node scripts/autodial-from-tz.mjs Denver-MT
 *   node scripts/autodial-from-tz.mjs 650-PT
 *
 * Optional 2nd arg overrides the callback phone:
 *   node scripts/autodial-from-tz.mjs NY-ET 7042775862
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const POOL = [
  { phone: '+13322323877', tz: 'America/New_York',    area_code: 332, label: 'NY-ET' },
  { phone: '+18723601655', tz: 'America/Chicago',     area_code: 872, label: 'Chicago-CT' },
  { phone: '+17207401703', tz: 'America/Denver',      area_code: 720, label: 'Denver-MT' },
  { phone: '+16506484142', tz: 'America/Los_Angeles', area_code: 650, label: '650-PT' },
];

const labelArg = process.argv[2];
const callbackOverride = process.argv[3] || '7042775862';
const entry = POOL.find(p => p.label === labelArg);
if (!entry) {
  console.error(`Unknown timezone label "${labelArg}". Valid: ${POOL.map(p => p.label).join(', ')}`);
  process.exit(1);
}

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const childEnv = { ...process.env };
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) childEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
childEnv.RETELL_PHONE_POOL = JSON.stringify([entry]);
childEnv.AUTODIAL_CALLBACK_PHONE = callbackOverride;

console.log(`[autodial-from-tz] firing from=${entry.label} (${entry.phone}) callback=${callbackOverride}`);

const child = spawn('npx', ['-y', 'tsx', 'scripts/autodial-irs-callback.ts'], {
  env: childEnv,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
