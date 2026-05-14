/**
 * One-shot wrapper: force the autodial to use the NY-ET number
 * (+13322323877) for this call instead of letting the picker default
 * to 650-PT.
 *
 * Why: at 1:55 PT / 4:55 ET, the picker chooses PT because PT has the
 * most remaining window. But IRS PPS routing is area-code-based, and
 * an ET-area-code number lands in an ET call center near the 7pm ET
 * close — agents tend to clear callbacks faster in the last 2 hours
 * to avoid leaving callers holding overnight. Matt's directive 2026-05-14.
 *
 * Trick: spawn the autodial script with RETELL_PHONE_POOL pre-set in
 * env to contain ONLY the NY-ET entry. The pool loader picks that
 * one (no choice).
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const NY_ET_ONLY = JSON.stringify([{
  phone: '+13322323877',
  tz: 'America/New_York',
  area_code: 332,
  label: 'NY-ET',
}]);

// Load .env.local manually so we can override RETELL_PHONE_POOL before
// passing env down to the child. (dotenv-cli would otherwise overwrite
// our override with whatever's in the file.)
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const childEnv = { ...process.env };
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) childEnv[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
// Force ET-only AFTER loading .env.local, so this overrides the
// file's pool entry.
childEnv.RETELL_PHONE_POOL = NY_ET_ONLY;

console.log(`[autodial-from-et] forcing pool to NY-ET only: +13322323877`);

const child = spawn('npx', ['-y', 'tsx', 'scripts/autodial-irs-callback.ts'], {
  env: childEnv,
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 1));
