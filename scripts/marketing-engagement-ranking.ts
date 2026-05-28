/**
 * Per-recipient engagement ranking for the May 2026 marketing campaign.
 *
 * Pulls SendGrid's Email Activity API (the messages search endpoint),
 * aggregates by recipient, and prints a ranked list of who's clicking
 * and opening the most. Useful for sales handoff: "these are your hot
 * leads right now."
 *
 * Run:
 *   npx tsx scripts/marketing-engagement-ranking.ts
 *   npx tsx scripts/marketing-engagement-ranking.ts --limit 25
 *   npx tsx scripts/marketing-engagement-ranking.ts --csv > /tmp/hot.csv
 *
 * Notes:
 *   - SendGrid Email Activity API retains 30 days of message events.
 *   - The /messages endpoint requires the "Email Activity" add-on on
 *     some plans; if you get 403, fall back to the Stats API which
 *     only gives aggregates (already used by marketing-daily-report).
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

const SG_KEY = process.env.SENDGRID_API_KEY!;
if (!SG_KEY) {
  console.error('SENDGRID_API_KEY missing in .env.local');
  process.exit(1);
}

const argv = process.argv.slice(2);
const csv = argv.includes('--csv');
const limitArg = argv.indexOf('--limit');
const printLimit = limitArg !== -1 ? parseInt(argv[limitArg + 1] || '25', 10) : 25;

interface MessageRow {
  msg_id: string;
  to_email: string;
  subject: string;
  status: string;
  opens_count: number;
  clicks_count: number;
  last_event_time: string;
  api_key_name?: string;
  categories?: string[];
}

interface RecipientAgg {
  email: string;
  name: string;
  totalOpens: number;
  totalClicks: number;
  delivered: number;
  bounced: number;
  unsub: boolean;
  spamReported: boolean;
  lastEvent: string;
  subjects: Set<string>;
  categories: Set<string>;
}

/**
 * Pull messages matching a SendGrid query. Returns up to 1000 rows
 * per call; we don't paginate further because the May 2026 campaign
 * is well under that volume.
 */
async function fetchMessages(query: string): Promise<MessageRow[]> {
  // The Email Activity API caps each request at 1000 rows. Loop using
  // last_event_time as a cursor (oldest event we've seen so far minus
  // 1 second) until we exhaust the result set or hit a sane upper
  // bound. We sort by last_event_time DESC so each page covers the
  // next-older slice.
  const all: MessageRow[] = [];
  const seen = new Set<string>();
  let cursorTs: string | null = null;
  for (let page = 0; page < 20; page++) {
    const pageQuery = cursorTs
      ? `${query} AND last_event_time < TIMESTAMP "${cursorTs}"`
      : query;
    const url = `https://api.sendgrid.com/v3/messages?query=${encodeURIComponent(pageQuery)}&limit=1000`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${SG_KEY}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SendGrid messages API ${res.status}: ${body}`);
    }
    const data: any = await res.json();
    const rows: MessageRow[] = data.messages || [];
    if (rows.length === 0) break;
    let added = 0;
    let oldestTs: string | null = null;
    for (const r of rows) {
      if (seen.has(r.msg_id)) continue;
      seen.add(r.msg_id);
      all.push(r);
      added++;
      if (!oldestTs || (r.last_event_time && r.last_event_time < oldestTs)) {
        oldestTs = r.last_event_time;
      }
    }
    // If we got fewer than the page size OR no new rows, we're done.
    if (added === 0 || rows.length < 25) break;
    cursorTs = oldestTs;
    if (!cursorTs) break;
  }
  return all;
}

/** Try to extract a real name from local-part of an email. Best-effort. */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] || '';
  // common patterns: first.last, first_last, firstlast, first-last
  const parts = local
    .replace(/[._-]/g, ' ')
    .split(' ')
    .filter(p => p && !/^\d+$/.test(p))
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  return parts.join(' ') || local;
}

async function main() {
  // Categories the May campaign uses (see scripts/marketing-daily-report.ts).
  // Querying each separately keeps the result-set well under 1000.
  const categories = ['may2026', 'lender_reactivation', 'compliance_outreach'];

  // SendGrid Email Activity API uses Contains(categories, "...") for
  // category filter. last_event_time uses TIMESTAMP literal.
  const queries = categories.map(cat =>
    `Contains(categories,"${cat}") AND last_event_time BETWEEN TIMESTAMP "2026-05-01T00:00:00Z" AND TIMESTAMP "${new Date().toISOString().split('T')[0]}T23:59:59Z"`,
  );

  console.error(`Querying SendGrid for ${queries.length} categories…`);
  const allMessages: MessageRow[] = [];
  for (let i = 0; i < queries.length; i++) {
    const cat = categories[i];
    try {
      const rows = await fetchMessages(queries[i]);
      console.error(`  ${cat}: ${rows.length} messages`);
      rows.forEach(r => {
        r.categories = r.categories || [cat];
      });
      allMessages.push(...rows);
    } catch (err) {
      console.error(`  ${cat}: FAILED — ${err instanceof Error ? err.message : err}`);
    }
  }
  console.error(`Total messages: ${allMessages.length}\n`);

  // Aggregate per recipient.
  const byEmail = new Map<string, RecipientAgg>();
  for (const m of allMessages) {
    const email = (m.to_email || '').toLowerCase();
    if (!email) continue;
    if (!byEmail.has(email)) {
      byEmail.set(email, {
        email,
        name: nameFromEmail(email),
        totalOpens: 0,
        totalClicks: 0,
        delivered: 0,
        bounced: 0,
        unsub: false,
        spamReported: false,
        lastEvent: '',
        subjects: new Set(),
        categories: new Set(),
      });
    }
    const agg = byEmail.get(email)!;
    agg.totalOpens += m.opens_count || 0;
    agg.totalClicks += m.clicks_count || 0;
    if (m.status === 'delivered' || m.status === 'opened' || m.status === 'clicked') agg.delivered += 1;
    if (m.status === 'bounced') agg.bounced += 1;
    if (m.status === 'unsubscribed') agg.unsub = true;
    if (m.status === 'spam_reports' || m.status === 'spam_report') agg.spamReported = true;
    if (m.subject) agg.subjects.add(m.subject);
    if (m.last_event_time && m.last_event_time > agg.lastEvent) agg.lastEvent = m.last_event_time;
    (m.categories || []).forEach(c => agg.categories.add(c));
  }

  // Engagement score: clicks weigh much more than opens (a click is
  // intent; an open might be Mimecast prefetching). Score = clicks*3 + opens.
  const ranked = Array.from(byEmail.values())
    .filter(r => !r.unsub && !r.spamReported)
    .map(r => ({ ...r, score: r.totalClicks * 3 + r.totalOpens }))
    .sort((a, b) => b.score - a.score)
    .slice(0, printLimit);

  if (csv) {
    console.log('rank,email,name,clicks,opens,delivered,categories,last_event,top_subject');
    ranked.forEach((r, i) => {
      const cats = Array.from(r.categories).join('|');
      const subj = Array.from(r.subjects)[0] || '';
      console.log(
        [
          i + 1,
          r.email,
          `"${r.name.replace(/"/g, '""')}"`,
          r.totalClicks,
          r.totalOpens,
          r.delivered,
          cats,
          r.lastEvent,
          `"${subj.replace(/"/g, '""')}"`,
        ].join(','),
      );
    });
    return;
  }

  console.log(`\n=== Top ${ranked.length} most-engaged recipients (clicks×3 + opens) ===\n`);
  console.log('Rank  Clicks  Opens   Name                              Email                                     Last event');
  console.log('────  ──────  ──────  ────────────────────────────────  ────────────────────────────────────────  ──────────');
  ranked.forEach((r, i) => {
    const rank = String(i + 1).padStart(3);
    const clicks = String(r.totalClicks).padStart(5);
    const opens = String(r.totalOpens).padStart(5);
    const name = r.name.slice(0, 32).padEnd(32);
    const email = r.email.slice(0, 40).padEnd(40);
    const last = r.lastEvent ? new Date(r.lastEvent).toISOString().split('T')[0] : '—';
    console.log(`${rank}.  ${clicks}   ${opens}   ${name}  ${email}  ${last}`);
  });

  // Quick "click-heavy" callout — clicks are intent, opens are noise.
  const clickHeavy = ranked.filter(r => r.totalClicks >= 2);
  if (clickHeavy.length > 0) {
    console.log(`\n→ ${clickHeavy.length} recipient(s) clicked ≥ 2 times — these are the hottest leads:`);
    clickHeavy.forEach(r => {
      console.log(`  • ${r.name} <${r.email}>  (${r.totalClicks} clicks across ${r.subjects.size} email${r.subjects.size === 1 ? '' : 's'})`);
    });
  }
}

main().catch(e => { console.error(e); process.exit(1); });
