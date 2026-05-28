/**
 * Queue Monday-morning personalized follow-ups to the 25 high-engagement
 * lenders who clicked the may2026 campaign 6+ times this week.
 *
 * Flow:
 *   - Loads scripts/data/cohort-may7.json (email, first, company, clicks).
 *   - For each row, builds a 4-line personal note from matt@moderntax.io.
 *   - Schedules SendGrid delivery for Monday 9:00 AM PT (via send_at, Unix
 *     epoch seconds). Sends are staggered 90s apart so the inbox doesn't
 *     wave-spam at exactly 9:00:00.
 *
 * Usage:
 *   npx tsx scripts/queue-cohort-monday.ts            # dry-run preview
 *   npx tsx scripts/queue-cohort-monday.ts --send     # actually queue
 *
 * Reply-to: matt@moderntax.io (so engaged readers reach the founder, not the
 * generic hello@). FROM is hello@moderntax.io to keep the sender history
 * consistent with the campaign warm-up.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import * as fs from 'fs';

interface Row { email: string; first: string; company: string; clicks: number }

const FROM_EMAIL = 'matt@moderntax.io';
const FROM_NAME = 'Matt Parker';
const REPLY_TO = 'matt@moderntax.io';
const HUBSPOT_BOOKING = 'https://meetings.hubspot.com/matt-moderntax/moderntax-intro';

// Monday May 11, 2026 at 9:00 AM PT (= 16:00 UTC during PDT). SendGrid
// `send_at` accepts Unix epoch seconds; first send at the top of the hour
// then 90s apart so 25 sends finish by ~9:38 AM.
const MONDAY_9AM_PT_UTC = new Date('2026-05-11T16:00:00.000Z').getTime() / 1000;
const STAGGER_SECONDS = 90;

function buildSubject(row: Row): string {
  // Vary subjects slightly so the cohort doesn't trigger spam-filter
  // pattern-matching on identical subject lines hitting the same week.
  const variants = [
    `Quick follow-up — ${row.company} + ModernTax?`,
    `${row.company} + faster SBA underwriting — 15 min?`,
    `Saw your interest — ${row.company} + ModernTax`,
    `${row.first}, 15 min on transcripts?`,
  ];
  // Stable per-recipient pick so repeated runs use the same subject.
  const idx = (row.email.charCodeAt(0) + row.email.length) % variants.length;
  return variants[idx];
}

function buildBody(row: Row): string {
  const greeting = row.first === 'team' || row.first === 'there'
    ? 'Hi there'
    : `Hi ${row.first}`;

  return `<div style="font-family: system-ui, -apple-system, sans-serif; color: #13213e; max-width: 560px; line-height: 1.55; font-size: 15px;">
<p>${greeting},</p>

<p>Saw you spent some time on the SBA verification email last week — thanks for taking a look.</p>

<p>Happy to walk through how <strong>${row.company}</strong> could shave underwriting time on transcripts and 8821s. We're getting most lenders from a 30-day intake to a 5-day intake, and a few of your peers (Centerstone SBA, California Statewide CDC) are already running on it.</p>

<p>Got 15 min Tuesday or Wednesday next week? <a href="${HUBSPOT_BOOKING}" style="color:#00C48C;font-weight:600;">Pick a slot here</a>, or just reply with what works.</p>

<p style="margin-top:18px;">Best,<br/>
Matt Parker<br/>
Founder, ModernTax<br/>
<a href="mailto:matt@moderntax.io" style="color:#00C48C;">matt@moderntax.io</a> · <a href="https://moderntax.io" style="color:#00C48C;">moderntax.io</a></p>
</div>`;
}

async function main() {
  const send = process.argv.includes('--send');
  const sgMail = (await import('@sendgrid/mail')).default;
  if (!process.env.SENDGRID_API_KEY) {
    console.error('SENDGRID_API_KEY missing');
    process.exit(1);
  }
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const rows: Row[] = JSON.parse(fs.readFileSync('scripts/data/cohort-may7.json', 'utf8'));
  console.log(`Loaded ${rows.length} cohort rows.`);
  console.log(`Send mode: ${send ? '🟢 LIVE' : '⚪ DRY RUN — pass --send to queue'}`);
  console.log(`Schedule:  ${new Date(MONDAY_9AM_PT_UTC * 1000).toISOString()} (Mon 9:00 AM PT)`);
  console.log(`Stagger:   ${STAGGER_SECONDS}s between sends`);
  console.log('');

  let queued = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const subject = buildSubject(row);
    const sendAt = Math.floor(MONDAY_9AM_PT_UTC + i * STAGGER_SECONDS);
    const sendAtIso = new Date(sendAt * 1000).toISOString().slice(11, 16);
    const greetingPreview = row.first === 'team' || row.first === 'there' ? 'Hi there' : `Hi ${row.first}`;

    if (!send) {
      console.log(`  [${String(i + 1).padStart(2)}/${rows.length}] ${sendAtIso} UTC  ${row.email.padEnd(45)}  "${subject}"`);
      console.log(`        → ${greetingPreview}, … ${row.company} … 15 min Tuesday/Wednesday?`);
      continue;
    }

    try {
      const [resp] = await sgMail.send({
        to: row.email,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        replyTo: REPLY_TO,
        subject,
        html: buildBody(row),
        // SendGrid scheduled-send: epoch seconds, max 72h ahead.
        sendAt,
        // Track in SendGrid analytics under a dedicated category.
        categories: ['cohort_followup_2026_05', 'lender_followup'],
        customArgs: {
          campaign: 'cohort_followup_2026_05',
          original_clicks: String(row.clicks),
          recipient_company: row.company,
        },
        trackingSettings: {
          clickTracking: { enable: true, enableText: false },
          openTracking: { enable: true },
        },
      } as any);
      const messageId = resp.headers?.['x-message-id'] || 'sent';
      queued++;
      console.log(`  [${String(i + 1).padStart(2)}/${rows.length}] ${sendAtIso} UTC  ${row.email.padEnd(45)}  ✓ queued (msg=${messageId})`);
    } catch (err: any) {
      console.error(`  [${String(i + 1).padStart(2)}/${rows.length}] ${row.email.padEnd(45)}  ✗ ${err?.response?.body?.errors?.[0]?.message || err?.message || err}`);
    }
  }

  console.log('');
  if (send) {
    console.log(`✓ Queued ${queued}/${rows.length} sends for Monday 9 AM PT.`);
    console.log('  To cancel a queued message: SendGrid → Mail → Scheduled (or use the SendGrid scheduled-sends API with batch_id).');
  } else {
    console.log('Re-run with --send to actually queue the sends.');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
