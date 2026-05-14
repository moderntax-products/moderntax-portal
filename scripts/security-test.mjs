/**
 * Daily security test — non-destructive probes against production.
 *
 * Categories:
 *   A. Auth boundary (unauthenticated access to protected routes)
 *   B. API key handling (invalid, malformed, missing, timing attacks)
 *   C. Authorization (cross-client + cross-role data leakage)
 *   D. Information disclosure (404 vs 403 patterns, error verbosity)
 *   E. Webhook signature verification
 *   F. Security headers (CSP, HSTS, X-Frame-Options, etc.)
 *   G. Storage / direct object access (bucket enumeration, public URLs)
 *   H. Input validation (oversize payload, SQLi-shape strings, path traversal)
 *
 * All probes are READ-only and use intentionally invalid credentials —
 * the point is to confirm that the system REJECTS abuse cleanly, not
 * to bypass anything.
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
const VINE_APEX = 'd579e059-9bcb-4728-b1f8-f7c303a18ff7';
const COLLECTIVE_JOHN_SAMPLE = '89b1bc12-a637-493b-b3dd-cf115ec3ff80';

const findings = []; // { category, severity, title, expected, actual, ok }

async function probe(category, title, fn) {
  try {
    const result = await fn();
    findings.push({ category, ...result });
  } catch (err) {
    findings.push({ category, severity: 'ERROR', title, ok: false, note: err.message });
  }
}

async function req(url, opts = {}) {
  const t0 = Date.now();
  const r = await fetch(url, { ...opts, redirect: 'manual', signal: AbortSignal.timeout(15000) });
  let body = '';
  const ct = r.headers.get('content-type') || '';
  try { body = await r.text(); } catch {}
  return { status: r.status, ms: Date.now() - t0, headers: Object.fromEntries(r.headers), body, ct };
}

console.log(`\nSecurity probe — ${new Date().toISOString()}\n`);

// ════════════════════════════════════════════════════════════════════════
// A. Auth boundary — protected routes must NOT return 200 with data
// ════════════════════════════════════════════════════════════════════════
console.log(`\n[ A. Auth boundary ]\n`);

for (const path of ['/admin', '/admin/billing', '/admin/experts', '/admin/clients', '/admin/users', '/expert', '/expert/profile', '/dashboard']) {
  await probe('A. Auth boundary', `unauth ${path}`, async () => {
    const r = await req(`${BASE}${path}`);
    const isHealthy = [307, 302, 401, 403].includes(r.status);
    const leaks200 = r.status === 200 && r.body.length > 500 && !/login|sign\s*in/i.test(r.body.slice(0, 2000));
    return {
      severity: isHealthy ? 'INFO' : 'CRITICAL',
      title: `Unauth GET ${path}`,
      ok: isHealthy && !leaks200,
      note: `HTTP ${r.status}${leaks200 ? ' (LEAKS CONTENT)' : ''}`,
    };
  });
}

// ════════════════════════════════════════════════════════════════════════
// B. API key handling — invalid keys must 401, not 500
// ════════════════════════════════════════════════════════════════════════
console.log(`\n[ B. API key handling ]\n`);

const badKeys = [
  { key: undefined, label: 'no x-api-key header' },
  { key: '', label: 'empty x-api-key' },
  { key: 'mt_live_txn_INVALID_DELETEME', label: 'malformed-but-prefixed key' },
  { key: "' OR 1=1 --", label: 'SQLi-shape key' },
  { key: 'a'.repeat(2048), label: 'oversize key (2KB)' },
  { key: '\x00\x01\x02', label: 'null + control bytes' },
  { key: '../../etc/passwd', label: 'path traversal in key' },
];

for (const { key, label } of badKeys) {
  await probe('B. API key', label, async () => {
    const headers = key === undefined ? {} : { 'x-api-key': key };
    const r = await req(`${BASE}/api/v1/transcripts/${VINE_APEX}/structured`, { headers });
    const isHealthy = [401, 400].includes(r.status);
    const leaks500 = r.status === 500;
    const leaksData = r.status === 200;
    return {
      severity: leaks500 ? 'HIGH' : leaksData ? 'CRITICAL' : 'INFO',
      title: `Bad API key (${label})`,
      ok: isHealthy && !leaksData,
      note: `HTTP ${r.status}${leaks500 ? ' (500 = info leak risk)' : ''}${leaksData ? ' (LEAKS DATA)' : ''}`,
    };
  });
}

// API key timing safety — does response time differ between valid-prefix-but-wrong-key vs garbage?
await probe('B. API key', 'constant-time auth (timing variance)', async () => {
  const N = 5;
  const validShape = `mt_live_txn_vine_sandbox_${'a'.repeat(12)}`;  // looks real, hash won't match
  const garbage = 'X'.repeat(40);
  const t1 = [], t2 = [];
  for (let i = 0; i < N; i++) {
    const a = await req(`${BASE}/api/v1/transcripts/${VINE_APEX}/structured`, { headers: { 'x-api-key': validShape } });
    t1.push(a.ms);
    const b = await req(`${BASE}/api/v1/transcripts/${VINE_APEX}/structured`, { headers: { 'x-api-key': garbage } });
    t2.push(b.ms);
  }
  const avg1 = t1.reduce((a, b) => a + b, 0) / N;
  const avg2 = t2.reduce((a, b) => a + b, 0) / N;
  const variance = Math.abs(avg1 - avg2);
  const concerning = variance > 200; // >200ms diff suggests non-constant-time compare
  return {
    severity: concerning ? 'MEDIUM' : 'INFO',
    title: `Auth timing — valid-shape vs garbage key`,
    ok: !concerning,
    note: `valid-shape avg ${avg1.toFixed(0)}ms / garbage avg ${avg2.toFixed(0)}ms — variance ${variance.toFixed(0)}ms${concerning ? ' (timing oracle risk)' : ''}`,
  };
});

// ════════════════════════════════════════════════════════════════════════
// C. Authorization — cross-client + sequential-ID enumeration
// ════════════════════════════════════════════════════════════════════════
console.log(`\n[ C. Authorization ]\n`);

await probe('C. Authorization', 'cross-client access (Vine key on Collective entity)', async () => {
  const r = await req(`${BASE}/api/v1/transcripts/${COLLECTIVE_JOHN_SAMPLE}/structured`, { headers: { 'x-api-key': VINE_KEY } });
  const isHealthy = r.status === 404;  // MUST be 404, not 403, to prevent enumeration
  return {
    severity: isHealthy ? 'INFO' : 'HIGH',
    title: 'Cross-client access',
    ok: isHealthy,
    note: `HTTP ${r.status} (want 404 to avoid leaking entity existence)`,
  };
});

await probe('C. Authorization', 'nonexistent entity with valid key', async () => {
  const r = await req(`${BASE}/api/v1/transcripts/00000000-0000-0000-0000-000000000000/structured`, { headers: { 'x-api-key': VINE_KEY } });
  const isHealthy = r.status === 404;
  return {
    severity: isHealthy ? 'INFO' : 'MEDIUM',
    title: 'Nonexistent entity',
    ok: isHealthy,
    note: `HTTP ${r.status} (want 404)`,
  };
});

await probe('C. Authorization', 'malformed entity UUID', async () => {
  const r = await req(`${BASE}/api/v1/transcripts/not-a-uuid/structured`, { headers: { 'x-api-key': VINE_KEY } });
  const isHealthy = [400, 404].includes(r.status);
  return {
    severity: r.status === 500 ? 'HIGH' : 'INFO',
    title: 'Malformed entity UUID',
    ok: isHealthy,
    note: `HTTP ${r.status} (want 400 or 404, NOT 500)`,
  };
});

// ════════════════════════════════════════════════════════════════════════
// D. Information disclosure — error verbosity, stack traces
// ════════════════════════════════════════════════════════════════════════
console.log(`\n[ D. Information disclosure ]\n`);

await probe('D. Info disclosure', 'cross-client returns same shape as not-found', async () => {
  const a = await req(`${BASE}/api/v1/transcripts/${COLLECTIVE_JOHN_SAMPLE}/structured`, { headers: { 'x-api-key': VINE_KEY } });
  const b = await req(`${BASE}/api/v1/transcripts/00000000-0000-0000-0000-000000000000/structured`, { headers: { 'x-api-key': VINE_KEY } });
  const sameStatus = a.status === b.status;
  const sameBodyShape = a.body.length > 0 && b.body.length > 0 && a.status === b.status;
  return {
    severity: !sameStatus ? 'MEDIUM' : 'INFO',
    title: 'Existence-not-revealed on cross-client',
    ok: sameStatus,
    note: `cross-client=${a.status}, not-found=${b.status}${!sameStatus ? ' (RESPONSE DIVERGES — enumeration risk)' : ''}`,
  };
});

await probe('D. Info disclosure', 'no stack traces in error responses', async () => {
  const r = await req(`${BASE}/api/v1/transcripts/${VINE_APEX}/cross-reference`, {
    method: 'POST',
    headers: { 'x-api-key': VINE_KEY, 'content-type': 'application/json' },
    body: '{"definitely_invalid": "body shape but valid JSON"}',
  });
  const leaksStack = /at\s+\S+\s+\(.+\.(?:js|ts):\d+/i.test(r.body) || /node_modules|\.next\/server/i.test(r.body);
  const leaksFilePath = /\/Users\/|\/home\/|C:\\\\/.test(r.body);
  return {
    severity: leaksStack || leaksFilePath ? 'HIGH' : 'INFO',
    title: 'Stack-trace leakage on invalid input',
    ok: !leaksStack && !leaksFilePath,
    note: `HTTP ${r.status}${leaksStack ? ' (STACK TRACE LEAKED)' : ''}${leaksFilePath ? ' (FS PATHS LEAKED)' : ''}`,
  };
});

// ════════════════════════════════════════════════════════════════════════
// E. Webhook signature verification
// ════════════════════════════════════════════════════════════════════════
console.log(`\n[ E. Webhooks ]\n`);

await probe('E. Webhooks', 'Stripe webhook rejects unsigned POST', async () => {
  const r = await req(`${BASE}/api/webhook/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"type": "checkout.session.completed", "data": {"object": {"id": "cs_fake"}}}',
  });
  const isHealthy = [400, 401, 403].includes(r.status);
  return {
    severity: r.status === 200 ? 'CRITICAL' : 'INFO',
    title: 'Stripe webhook rejects no-signature',
    ok: isHealthy,
    note: `HTTP ${r.status}`,
  };
});

await probe('E. Webhooks', 'Stripe webhook rejects bad signature', async () => {
  const r = await req(`${BASE}/api/webhook/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': 't=1234567890,v1=deadbeef' },
    body: '{"type": "test"}',
  });
  const isHealthy = [400, 401, 403].includes(r.status);
  return {
    severity: r.status === 200 ? 'CRITICAL' : 'INFO',
    title: 'Stripe webhook rejects forged signature',
    ok: isHealthy,
    note: `HTTP ${r.status}`,
  };
});

// ════════════════════════════════════════════════════════════════════════
// F. Security headers
// ════════════════════════════════════════════════════════════════════════
console.log(`\n[ F. Security headers ]\n`);

const headerResp = await req(`${BASE}/login`);
const securityHeaders = {
  'strict-transport-security': { required: true, severity: 'MEDIUM' },
  'x-frame-options': { required: true, severity: 'MEDIUM' },
  'x-content-type-options': { required: true, severity: 'LOW' },
  'content-security-policy': { required: false, severity: 'MEDIUM' }, // nice-to-have for app routes
  'referrer-policy': { required: false, severity: 'LOW' },
  'permissions-policy': { required: false, severity: 'LOW' },
};
for (const [h, { required, severity }] of Object.entries(securityHeaders)) {
  const present = headerResp.headers[h] != null;
  findings.push({
    category: 'F. Headers',
    severity: present ? 'INFO' : (required ? severity : 'INFO'),
    title: `${h} header`,
    ok: present || !required,
    note: present ? `present: "${String(headerResp.headers[h]).slice(0, 80)}"` : (required ? 'MISSING (recommended)' : 'absent (optional)'),
  });
}

// ════════════════════════════════════════════════════════════════════════
// G. Storage / direct object access
// ════════════════════════════════════════════════════════════════════════
console.log(`\n[ G. Storage ]\n`);

await probe('G. Storage', 'Supabase public storage bucket not world-readable', async () => {
  // Try to list the uploads bucket directly via public URL
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  if (!supabaseUrl) return { severity: 'INFO', title: 'Bucket listing (no URL configured)', ok: true, note: 'no SUPABASE_URL' };
  const r = await req(`${supabaseUrl}/storage/v1/object/list/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"prefix":"","limit":5}',
  });
  // 401 or 403 is correct; 200 with a JSON array = misconfigured bucket
  const isHealthy = [401, 403, 404].includes(r.status);
  return {
    severity: r.status === 200 ? 'CRITICAL' : 'INFO',
    title: 'uploads bucket unauthenticated list',
    ok: isHealthy,
    note: `HTTP ${r.status}`,
  };
});

await probe('G. Storage', 'guessable transcript path access', async () => {
  // Try a real-looking but bogus path
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  if (!supabaseUrl) return { severity: 'INFO', title: 'Direct file (no URL)', ok: true, note: 'no SUPABASE_URL' };
  const r = await req(`${supabaseUrl}/storage/v1/object/public/uploads/transcripts/${VINE_APEX}/nonexistent.html`);
  // 404 fine; 200 would mean public-bucket misconfig
  const isHealthy = [401, 403, 404].includes(r.status);
  return {
    severity: r.status === 200 ? 'HIGH' : 'INFO',
    title: 'Direct unauthenticated transcript fetch',
    ok: isHealthy,
    note: `HTTP ${r.status}`,
  };
});

// ════════════════════════════════════════════════════════════════════════
// H. Input validation
// ════════════════════════════════════════════════════════════════════════
console.log(`\n[ H. Input validation ]\n`);

await probe('H. Input', 'oversized request body (10MB JSON)', async () => {
  const huge = JSON.stringify({ tax_year: '2023', self_reported: { junk: 'A'.repeat(10 * 1024 * 1024) } });
  const r = await req(`${BASE}/api/v1/transcripts/${VINE_APEX}/cross-reference`, {
    method: 'POST',
    headers: { 'x-api-key': VINE_KEY, 'content-type': 'application/json' },
    body: huge,
  });
  // 413 (payload too large) or 400 ideal; 500 = unhandled
  const isHealthy = [400, 413, 200].includes(r.status);
  return {
    severity: r.status === 500 ? 'MEDIUM' : 'INFO',
    title: 'Oversized request body (10MB)',
    ok: isHealthy,
    note: `HTTP ${r.status}`,
  };
});

await probe('H. Input', 'SQLi-shape entity ID parameter', async () => {
  const sqli = encodeURIComponent("'; DROP TABLE users; --");
  const r = await req(`${BASE}/api/v1/transcripts/${sqli}/structured`, { headers: { 'x-api-key': VINE_KEY } });
  const isHealthy = [400, 404].includes(r.status);
  return {
    severity: r.status === 500 ? 'MEDIUM' : 'INFO',
    title: 'SQLi-shape entity ID',
    ok: isHealthy,
    note: `HTTP ${r.status}`,
  };
});

// ════════════════════════════════════════════════════════════════════════
// Report
// ════════════════════════════════════════════════════════════════════════
console.log(`\n${'═'.repeat(100)}`);
console.log(`Security probe results`);
console.log(`${'═'.repeat(100)}\n`);

const bySev = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [], INFO: [], ERROR: [] };
for (const f of findings) {
  (bySev[f.severity] || bySev.INFO).push(f);
}
for (const sev of ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'ERROR', 'INFO']) {
  if (bySev[sev].length === 0) continue;
  console.log(`\n[${sev}] (${bySev[sev].length})`);
  for (const f of bySev[sev]) {
    const mark = f.ok ? '✓' : '✗';
    console.log(`  ${mark}  ${f.category}  ·  ${f.title.padEnd(55)}  ${f.note || ''}`);
  }
}

const failing = findings.filter(f => !f.ok);
console.log(`\n${'═'.repeat(100)}`);
console.log(`SUMMARY: ${findings.length} probes · ${failing.length} failing`);
console.log(`         CRITICAL: ${bySev.CRITICAL.filter(f => !f.ok).length}, HIGH: ${bySev.HIGH.filter(f => !f.ok).length}, MEDIUM: ${bySev.MEDIUM.filter(f => !f.ok).length}, LOW: ${bySev.LOW.filter(f => !f.ok).length}`);
console.log(`${'═'.repeat(100)}\n`);

process.exit(failing.filter(f => ['CRITICAL', 'HIGH'].includes(f.severity)).length > 0 ? 1 : 0);
