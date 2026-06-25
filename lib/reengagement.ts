/**
 * Processor Re-Engagement Sequence — templates + step schedule.
 *
 * Two lifecycle tracks nudge lender processors who have a ModernTax seat but
 * aren't ordering: Track A (never activated — signed up, 0 orders) and Track B
 * (lapsed — ordered before, now dormant 30+ days). A manager-loop email closes
 * each track. Founder voice, signed from Matt; one CTA per email.
 *
 * This module is pure content + schedule; the cron (app/api/cron/
 * reengagement-sequence) owns eligibility, suppression, send-window, and the
 * actual sending. Copy from Matt's spec (2026-06-25).
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://portal.moderntax.io';

/** From + signature: founder voice (Matt). Booking = existing HubSpot link. */
export const REP = {
  name: process.env.REENGAGEMENT_REP_NAME || 'Matt',
  email: process.env.REENGAGEMENT_REP_EMAIL || 'matt@moderntax.io',
};
export const BOOKING_URL =
  process.env.REENGAGEMENT_BOOKING_URL || 'https://meetings.hubspot.com/matt-moderntax/moderntax-intro';
export const ORDER_CTA_URL = `${APP_URL}/new`;
export const SUPPORT_EMAIL = 'support@moderntax.io';

export type Track = 'A' | 'B';
export type Audience = 'processor' | 'manager';

export interface MergeContext {
  firstName: string;
  lenderName: string;
  daysSinceSignup: number;
  daysSinceLastOrder: number;
  lastOrderDate: string | null;
  // Manager-loop only:
  managerFirstName?: string;
  idleSeatCount?: number;
  idleUserNames?: string;
}

export interface StepDef {
  step: string;        // 'A1'..'A4','B1'..'B4'
  track: Track;
  audience: Audience;
  /** Day threshold: days since signup (Track A) or since last order (Track B). */
  day: number;
  subject: (c: MergeContext) => string;
  body: (c: MergeContext) => string; // plain text; HTML derived from it
}

const sig = `\n\n— ${REP.name}, ModernTax`;

// ─── Track A — Never Activated ──────────────────────────────────────────────
const A1: StepDef = {
  step: 'A1', track: 'A', audience: 'processor', day: 3,
  subject: (c) => `Your ModernTax account is ready, ${c.firstName}`,
  body: (c) =>
`Hi ${c.firstName},

Your ModernTax seat for ${c.lenderName} is live, but I noticed you haven't run an order yet. Most processors get through their first one in under two minutes:

1. Log in and click New Order
2. Enter the borrower's details and upload (or e-sign) the 8821
3. We return the IRS transcript — usually same day

No faxing 4506-Cs, no waiting on hold with the IRS.

Place your first order: ${ORDER_CTA_URL}

If anything looks unclear, just reply — a real person reads these.${sig}`,
};

const A2: StepDef = {
  step: 'A2', track: 'A', audience: 'processor', day: 7,
  subject: (c) => `Same-day transcripts, ${c.firstName}`,
  body: (c) =>
`Hi ${c.firstName},

One reason to give ModernTax a try this week: our digital 8821 clears the IRS at a 96% acceptance rate, and pre-verification flags filing mismatches before a transcript comes back blank — so you're not restarting the request days later.

Your seat's already set up. The first order takes about two minutes.

Run a transcript: ${ORDER_CTA_URL}${sig}`,
};

const A3: StepDef = {
  step: 'A3', track: 'A', audience: 'processor', day: 12,
  subject: () => `Want me to run your first order with you?`,
  body: (c) =>
`Hi ${c.firstName},

Still no first order from your seat — totally fine; getting started on a new tool is the hardest part.

Want to do it together? Grab 10 minutes and we'll pull a live transcript on your next file, start to finish. You won't need help again after that.

Book 10 minutes: ${BOOKING_URL}

Or just reply with a file you're working on and I'll walk you through it.${sig}`,
};

const A4: StepDef = {
  step: 'A4', track: 'A', audience: 'manager', day: 16,
  subject: (c) => `${c.lenderName}'s ModernTax seats aren't being used yet`,
  body: (c) =>
`Hi ${c.managerFirstName || 'there'},

Flagging this in case it's useful: ${c.idleSeatCount} processor seat(s) on ${c.lenderName}'s ModernTax account are active but haven't placed an order yet — ${c.idleUserNames}.

Usually that just means a file hasn't landed since onboarding, or the workflow hasn't clicked yet. Happy to run a 15-minute team refresher so everyone's pulling transcripts the fast way.

Grab a time: ${BOOKING_URL}${sig}`,
};

// ─── Track B — Lapsed ───────────────────────────────────────────────────────
const B1: StepDef = {
  step: 'B1', track: 'B', audience: 'processor', day: 30,
  subject: (c) => `Haven't seen an order from you lately, ${c.firstName}`,
  body: (c) =>
`Hi ${c.firstName},

It's been about ${c.daysSinceLastOrder} days since your last transcript order, so I wanted to check in. Pipeline quiet, or did something get in the way on our end?

Your account's ready whenever the next file lands — same-day transcripts, same login.

Place an order: ${ORDER_CTA_URL}

If something wasn't working, reply and tell me — I'd rather fix it than guess.${sig}`,
};

const B2: StepDef = {
  step: 'B2', track: 'B', audience: 'processor', day: 37,
  subject: () => `A faster way through your next file`,
  body: (c) =>
`Hi ${c.firstName},

When you're back on a file, the two things that save processors the most time:

- Digital 8821 — e-signed, 96% IRS acceptance, no faxing
- Pre-verification — catches filing mismatches before the transcript comes back blank

If either wasn't part of your flow before, they're worth a look on your next order.

Start an order: ${ORDER_CTA_URL}${sig}`,
};

const B3: StepDef = {
  step: 'B3', track: 'B', audience: 'processor', day: 45,
  subject: (c) => `Should we keep your seat active, ${c.firstName}?`,
  body: (c) =>
`Hi ${c.firstName},

I don't want to keep nudging if ModernTax isn't part of your workflow right now.

If it's still useful, your seat's ready and your next transcript is two minutes away. If not, no problem — reply "pause" and I'll quiet these down.

Pull a transcript: ${ORDER_CTA_URL}${sig}`,
};

const B4: StepDef = {
  step: 'B4', track: 'B', audience: 'manager', day: 50,
  subject: (c) => `Quick flag: a ModernTax seat on ${c.lenderName} has gone quiet`,
  body: (c) =>
`Hi ${c.managerFirstName || 'there'},

Heads up — ${c.firstName} was actively pulling transcripts on ${c.lenderName}'s account but hasn't ordered in ${c.daysSinceLastOrder} days. Sometimes that's just a workflow change; sometimes a quick nudge keeps the team consistent.

Want me to check in directly, or set up a short refresher for the group?${sig}`,
};

/** Ordered steps per track (ascending day). */
export const TRACK_A_STEPS: StepDef[] = [A1, A2, A3, A4];
export const TRACK_B_STEPS: StepDef[] = [B1, B2, B3, B4];
export const ALL_STEPS: StepDef[] = [...TRACK_A_STEPS, ...TRACK_B_STEPS];

export function stepsForTrack(track: Track): StepDef[] {
  return track === 'A' ? TRACK_A_STEPS : TRACK_B_STEPS;
}

/** Render an email (subject + text + simple branded HTML) for a step. */
export function renderStep(def: StepDef, ctx: MergeContext): { subject: string; text: string; html: string } {
  const text = def.body(ctx);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Linkify the bare URLs we embed, then paragraph-wrap.
  const htmlBody = esc(text)
    .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" style="color:#0b8457;">$1</a>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#1a2b3c;line-height:1.55;font-size:15px;"><p>${htmlBody}</p></div>`;
  return { subject: def.subject(ctx), text, html };
}
