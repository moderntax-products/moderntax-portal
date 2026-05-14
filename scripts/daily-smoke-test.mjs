/**
 * Daily smoke test — exercises live production endpoints across all four
 * personas (processors, managers, API users, experts) to surface any
 * regression in the deployed surface area.
 *
 *   - API users: hits the /api/v1/transcripts structured + cross-reference
 *     endpoints against three prospect sandboxes (Vine, Collective, Moxie).
 *     Auth via x-api-key.
 *   - Admin/managers: HEAD requests to admin routes. 200/302/401/307 = healthy;
 *     500 = regression.
 *   - Public/unauth: marketing + login routes should serve 200/307 redirects.
 *   - Cron: hits cron endpoints without bearer — should return 401, not 500.
 */

import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const BASE = 'https://portal.moderntax.io';
const VINE_KEY = 'mt_live_txn_vine_sandbox_8dacbc9250b0';
const COLLECTIVE_KEY = 'mt_live_txn_collective_sandbox_4fdca67756d8';
const MOXIE_KEY = 'mt_live_txn_moxie_sandbox_ad4361d8266f';

const VINE_ENTITIES = {
  apex: 'd579e059-9bcb-4728-b1f8-f7c303a18ff7',
  sunrise: '9184daa6-d70b-4c34-bb67-33b9d8bc5abc',
  independence: 'a23ecac8-0fb6-45ab-8038-88787ff58597',
};
const COLLECTIVE_ENTITIES = {
  mapleEin: 'ecc49692-68b1-4b7f-8f99-8cf999c094df',
  johnSampleSsn: '89b1bc12-a637-493b-b3dd-cf115ec3ff80',
  quincySoleProp: '3aa6a12e-6e80-47a6-aef1-5d01663cb3d0',
};
const MOXIE_ENTITIES = {
  mountainBrew: '6af9e432-d8fc-4c39-918a-1a40624635ad',
  sunset: '372e5e54-24ca-4f84-8ee5-69f2f3d9ba7e',
  beacon: 'ebcb4f49-e8fc-4b63-b3cd-1770d3469908',
  twilight: '42fce442-e853-4a78-b28c-ed3c63259886',
  catalyst: '343b9632-e9bb-4775-ac5a-073836d47fec',
  greenfield: 'bd75a0ae-0f5d-462f-a586-daa299c32d70',
};

const results = []; // { persona, target, status, ms, ok, note }

async function hit(persona, target, url, opts = {}, validate) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      ...opts,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
    });
    const ms = Date.now() - t0;
    let body = null;
    let ok = false;
    let note = '';
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) body = await r.json().catch(() => null);
    if (validate) {
      const v = validate(r.status, body);
      ok = v.ok;
      note = v.note;
    } else {
      ok = r.status >= 200 && r.status < 400;
      note = `${r.status}`;
    }
    results.push({ persona, target, status: r.status, ms, ok, note });
  } catch (err) {
    results.push({ persona, target, status: 0, ms: Date.now() - t0, ok: false, note: err.message });
  }
}

console.log(`\nDaily smoke test — ${new Date().toISOString()}\n`);

// ─── API users ──────────────────────────────────────────────────────────
console.log(`\n[ API users — v1 transcripts endpoints ]\n`);

await Promise.all([
  hit('api-user (Vine)', 'structured Apex Coffee', `${BASE}/api/v1/transcripts/${VINE_ENTITIES.apex}/structured`, { headers: { 'x-api-key': VINE_KEY } },
    (s, b) => ({ ok: s === 200 && b?.entity?.name === 'Apex Coffee Roasters LLC' && b?.compliance?.overall_severity === 'CLEAN', note: s === 200 ? `severity=${b?.compliance?.overall_severity}` : `HTTP ${s}` })),
  hit('api-user (Vine)', 'structured Sunrise Plumbing', `${BASE}/api/v1/transcripts/${VINE_ENTITIES.sunrise}/structured`, { headers: { 'x-api-key': VINE_KEY } },
    (s, b) => ({ ok: s === 200 && b?.compliance?.overall_severity === 'CRITICAL' && b?.compliance?.tax_liabilities?.total_balance > 0, note: s === 200 ? `balance=$${b?.compliance?.tax_liabilities?.total_balance}` : `HTTP ${s}` })),
  hit('api-user (Vine)', 'cross-reference Apex', `${BASE}/api/v1/transcripts/${VINE_ENTITIES.apex}/cross-reference`, {
    method: 'POST', headers: { 'x-api-key': VINE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ tax_year: '2023', self_reported: { gross_receipts: 1842500 } }),
  }, (s, b) => ({ ok: s === 200 && b?.diffs?.[0]?.severity === 'MATCH', note: s === 200 ? `match=${b?.overall_match}` : `HTTP ${s}` })),
  hit('api-user (Vine)', 'invalid key rejected (401)', `${BASE}/api/v1/transcripts/${VINE_ENTITIES.apex}/structured`, { headers: { 'x-api-key': 'mt_live_txn_INVALID_DELETEME' } },
    (s) => ({ ok: s === 401, note: `HTTP ${s} (want 401)` })),
  hit('api-user (Vine)', 'cross-client access denied (404)', `${BASE}/api/v1/transcripts/${COLLECTIVE_ENTITIES.johnSampleSsn}/structured`, { headers: { 'x-api-key': VINE_KEY } },
    (s) => ({ ok: s === 404, note: `HTTP ${s} (want 404, not 403 — to prevent enumeration)` })),
  hit('api-user (Collective)', 'structured John Sample SSN (CRITICAL)', `${BASE}/api/v1/transcripts/${COLLECTIVE_ENTITIES.johnSampleSsn}/structured`, { headers: { 'x-api-key': COLLECTIVE_KEY } },
    (s, b) => ({ ok: s === 200 && b?.compliance?.overall_severity === 'CRITICAL' && (b?.compliance?.filing_compliance?.unfiled?.length || 0) >= 1, note: s === 200 ? `severity=${b?.compliance?.overall_severity} unfiled=${b?.compliance?.filing_compliance?.unfiled?.length}` : `HTTP ${s}` })),
  hit('api-user (Collective)', 'structured Maple Construction (clean)', `${BASE}/api/v1/transcripts/${COLLECTIVE_ENTITIES.mapleEin}/structured`, { headers: { 'x-api-key': COLLECTIVE_KEY } },
    (s, b) => ({ ok: s === 200 && b?.compliance?.overall_severity === 'CLEAN', note: s === 200 ? `severity=${b?.compliance?.overall_severity}` : `HTTP ${s}` })),
  hit('api-user (Moxie)', 'structured Greenfield (CRITICAL, change tracked)', `${BASE}/api/v1/transcripts/${MOXIE_ENTITIES.greenfield}/structured`, { headers: { 'x-api-key': MOXIE_KEY } },
    (s, b) => ({ ok: s === 200 && b?.compliance?.overall_severity === 'CRITICAL' && b?.compliance?.tax_liabilities?.total_balance === 9081.13, note: s === 200 ? `balance=$${b?.compliance?.tax_liabilities?.total_balance}` : `HTTP ${s}` })),
  hit('api-user (Moxie)', 'structured Mountain Brew (healthy)', `${BASE}/api/v1/transcripts/${MOXIE_ENTITIES.mountainBrew}/structured`, { headers: { 'x-api-key': MOXIE_KEY } },
    (s, b) => ({ ok: s === 200 && b?.compliance?.overall_severity === 'CLEAN', note: s === 200 ? `severity=${b?.compliance?.overall_severity}` : `HTTP ${s}` })),
]);

// ─── Manager/admin pages (HEAD requests) ─────────────────────────────────
console.log(`\n[ Manager/admin pages — require auth, expect 200/302/307/401 ]\n`);

await Promise.all([
  hit('manager', '/admin', `${BASE}/admin`, { method: 'GET' }, (s) => ({ ok: [200,302,307,401].includes(s), note: `HTTP ${s}` })),
  hit('manager', '/admin/billing', `${BASE}/admin/billing`, { method: 'GET' }, (s) => ({ ok: [200,302,307,401].includes(s), note: `HTTP ${s}` })),
  hit('manager', '/admin/experts', `${BASE}/admin/experts`, { method: 'GET' }, (s) => ({ ok: [200,302,307,401].includes(s), note: `HTTP ${s}` })),
  hit('manager', '/admin/clients', `${BASE}/admin/clients`, { method: 'GET' }, (s) => ({ ok: [200,302,307,401,404].includes(s), note: `HTTP ${s}` })),
]);

// ─── Processor pages ─────────────────────────────────────────────────────
console.log(`\n[ Processor pages — public landing, login flow ]\n`);

await Promise.all([
  hit('processor', '/ (home)', `${BASE}/`, { method: 'GET' }, (s) => ({ ok: [200,302,307].includes(s), note: `HTTP ${s}` })),
  hit('processor', '/login', `${BASE}/login`, { method: 'GET' }, (s) => ({ ok: [200,302,307].includes(s), note: `HTTP ${s}` })),
  hit('processor', '/dashboard', `${BASE}/dashboard`, { method: 'GET' }, (s) => ({ ok: [200,302,307,401].includes(s), note: `HTTP ${s}` })),
  hit('processor', '/reset-password', `${BASE}/reset-password`, { method: 'GET' }, (s) => ({ ok: [200,302,307].includes(s), note: `HTTP ${s}` })),
]);

// ─── Expert pages ────────────────────────────────────────────────────────
console.log(`\n[ Expert pages — require auth ]\n`);

await Promise.all([
  hit('expert', '/expert', `${BASE}/expert`, { method: 'GET' }, (s) => ({ ok: [200,302,307,401].includes(s), note: `HTTP ${s}` })),
  hit('expert', '/expert/profile', `${BASE}/expert/profile`, { method: 'GET' }, (s) => ({ ok: [200,302,307,401].includes(s), note: `HTTP ${s}` })),
]);

// ─── Cron + webhook endpoints (without auth = expect 401, NOT 500) ───────
console.log(`\n[ Cron endpoints — expect 401 (auth-protected), not 500 ]\n`);

await Promise.all([
  hit('cron', '/api/cron/8821-expiration-alert (no bearer → 401)', `${BASE}/api/cron/8821-expiration-alert`, {},
    (s) => ({ ok: s === 401, note: `HTTP ${s} (want 401)` })),
  hit('cron', '/api/cron/monitoring (no bearer → 401)', `${BASE}/api/cron/monitoring`, {},
    (s) => ({ ok: [401, 404].includes(s), note: `HTTP ${s}` })),
  hit('webhook', '/api/webhook/stripe (GET → 405/401)', `${BASE}/api/webhook/stripe`, {},
    (s) => ({ ok: [401, 405, 400].includes(s), note: `HTTP ${s}` })),
]);

// ─── Print results ──────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(100)}`);
console.log(`Results`);
console.log(`${'═'.repeat(100)}`);
const grouped = new Map();
for (const r of results) {
  if (!grouped.has(r.persona)) grouped.set(r.persona, []);
  grouped.get(r.persona).push(r);
}
let totalOk = 0, totalFail = 0;
for (const [persona, items] of grouped) {
  console.log(`\n[ ${persona} ]`);
  for (const r of items) {
    const mark = r.ok ? '✓' : '✗';
    console.log(`  ${mark}  ${r.target.padEnd(50)}  ${String(r.ms).padStart(5)}ms  ${r.note}`);
    if (r.ok) totalOk++; else totalFail++;
  }
}
console.log(`\n${'═'.repeat(100)}`);
console.log(`SUMMARY: ${totalOk} passing / ${totalFail} failing / ${results.length} total`);
console.log(`${'═'.repeat(100)}\n`);
process.exit(totalFail > 0 ? 1 : 0);
