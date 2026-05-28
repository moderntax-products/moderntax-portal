/**
 * Ingest Substack subscriber CSV into the marketing list.
 *
 * Substack export format (Settings → Subscribers → Export):
 *   email, active_subscription, expiry, email_disabled, created_at,...
 *
 * What this script does:
 *   1. Reads the CSV at scripts/data/substack-subscribers.csv
 *      (you download it from substack.com/settings → Subscribers → Export)
 *   2. Filters to active subscribers (active_subscription=true,
 *      email_disabled=false).
 *   3. For each, checks if they're already in scripts/data/hubspot-leads-may2026.json.
 *      Skips duplicates. Adds new ones with tier='substack' so downstream
 *      filters can distinguish HubSpot-sourced vs Substack-sourced.
 *   4. Writes the merged file back. The marketing cron picks them up on
 *      next batch run.
 *
 * Usage:
 *   1. Download CSV from Substack → Settings → Subscribers → Export → "All subscribers"
 *   2. Save as scripts/data/substack-subscribers.csv
 *   3. Run: npx tsx scripts/ingest-substack.ts
 *      (or `--send` to actually merge; default is dry-run)
 *
 * Substack provides first/last name only when the subscriber set them. If
 * missing, we leave the lead's first="" and the marketing template falls
 * back to "Hi there".
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import * as fs from 'fs';
import * as path from 'path';

interface ExistingLead {
  email: string;
  first?: string;
  last?: string;
  company?: string;
  created?: string;
  demo?: string | null;
  tier?: string;
  source?: string;
}

interface SubstackRow {
  email: string;
  active_subscription?: string;
  email_disabled?: string;
  created_at?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];
  // Naive CSV parser — handles simple quoted fields. Substack exports clean
  // CSV without weird quoting in subscriber data, so this works.
  const splitRow = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = !inQ;
      else if (c === ',' && !inQ) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = splitRow(lines[0]).map(h => h.trim().toLowerCase().replace(/[\s.-]+/g, '_'));
  return lines.slice(1).map(line => {
    const cells = splitRow(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (cells[i] || '').trim(); });
    return obj;
  });
}

async function main() {
  const send = process.argv.includes('--send');
  const csvPath = path.join('scripts', 'data', 'substack-subscribers.csv');
  const cachePath = path.join('scripts', 'data', 'hubspot-leads-may2026.json');

  if (!fs.existsSync(csvPath)) {
    console.error(`Missing ${csvPath}`);
    console.error(`Download from: https://substack.com/dashboard → Subscribers → Export`);
    process.exit(1);
  }
  if (!fs.existsSync(cachePath)) {
    console.error(`Missing ${cachePath} — marketing list cache not found.`);
    process.exit(1);
  }

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  const subs = parseCsv(fs.readFileSync(csvPath, 'utf8')) as unknown as SubstackRow[];
  console.log(`Loaded ${subs.length} Substack rows.`);

  // Build a lowercase email lookup of existing leads
  const existing = new Map<string, ExistingLead>();
  for (const lead of (cache.addressable as ExistingLead[])) {
    existing.set(lead.email.toLowerCase(), lead);
  }
  console.log(`Existing marketing list: ${existing.size} leads.`);

  // Filter: active subscribers only, no bounced/disabled
  const eligible = subs.filter(s => {
    if (!s.email || !s.email.includes('@')) return false;
    const active = (s.active_subscription || '').toLowerCase() !== 'false';
    const disabled = (s.email_disabled || '').toLowerCase() === 'true';
    return active && !disabled;
  });

  // Identify net-new
  const newOnes: ExistingLead[] = [];
  let dupes = 0;
  for (const s of eligible) {
    const email = s.email.toLowerCase();
    if (existing.has(email)) { dupes++; continue; }

    // Substack puts the whole name in `name`; some exports split into first/last.
    let first = (s.first_name || '').trim();
    let last = (s.last_name || '').trim();
    if (!first && s.name) {
      const parts = s.name.trim().split(/\s+/);
      first = parts[0] || '';
      last = parts.slice(1).join(' ');
    }

    newOnes.push({
      email,
      first,
      last,
      company: '',
      created: s.created_at || new Date().toISOString().split('T')[0],
      demo: null,
      tier: 'substack',
      source: 'substack',
    });
  }

  console.log('');
  console.log(`Substack active subscribers:        ${eligible.length}`);
  console.log(`  Already in marketing list:        ${dupes}`);
  console.log(`  Net new to add:                   ${newOnes.length}`);
  if (newOnes.length === 0) {
    console.log('Nothing to add. Done.');
    return;
  }

  console.log('\nSample of new entries:');
  for (const n of newOnes.slice(0, 8)) {
    console.log(`  ${n.email.padEnd(40)}  first="${n.first}"  last="${n.last}"`);
  }
  if (newOnes.length > 8) console.log(`  …+${newOnes.length - 8} more`);

  if (!send) {
    console.log('\n⚪ Dry-run. Re-run with --send to merge into marketing list.');
    return;
  }

  // Merge + write
  cache.addressable = [...(cache.addressable as ExistingLead[]), ...newOnes];
  cache.total_in_hubspot = cache.addressable.length;
  cache.last_substack_ingest = new Date().toISOString();
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  console.log(`\n✓ Merged ${newOnes.length} new Substack subscribers into ${cachePath}.`);
  console.log(`  Total marketing list now: ${cache.addressable.length} leads.`);
  console.log(`  Next may-marketing-batch cron run will pick these up.`);
}

main().catch(e => { console.error(e); process.exit(1); });
