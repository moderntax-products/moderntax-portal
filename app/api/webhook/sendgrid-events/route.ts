/**
 * SendGrid Event Webhook receiver
 * POST /api/webhook/sendgrid-events
 *
 * Persists every SendGrid event (delivered / open / click / bounce /
 * spam_report / unsubscribe / …) to the `sendgrid_events` table so the
 * /admin/email-engagement view can rank recipients without depending
 * on SendGrid's Email Activity API tier cap (25 messages per query).
 *
 * Configure in SendGrid: Settings → Mail Settings → Event Webhook
 *   HTTP POST URL:  https://portal.moderntax.io/api/webhook/sendgrid-events
 *   Events:         all of them
 *   Signature verification: ON
 *   Public key:     paste into env var SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY
 *
 * SendGrid signs every batch with an ECDSA P-256 key and sends:
 *   X-Twilio-Email-Event-Webhook-Signature: <base64 ECDSA sig>
 *   X-Twilio-Email-Event-Webhook-Timestamp: <unix seconds>
 *
 * Signed payload = `<timestamp><raw body bytes>` — order matters.
 * We verify with Node's built-in crypto using the public key as
 * PEM-formatted (SPKI) or base64-DER. Reject on any mismatch.
 *
 * SOC 2 CC6.1 — this is a public endpoint receiving authenticated
 * data; signature verification is the only thing standing between an
 * attacker and the ability to inject fake "open" events for arbitrary
 * recipients (which would poison the sales-handoff signal). Take it
 * seriously.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createPublicKey, createVerify } from 'crypto';
import { createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs'; // crypto.createVerify needs the Node runtime
export const dynamic = 'force-dynamic';

interface SendGridEvent {
  email: string;
  timestamp: number;
  event: string;
  sg_event_id: string;
  sg_message_id?: string;
  url?: string;
  useragent?: string;
  ip?: string;
  reason?: string;
  status?: string;
  category?: string | string[];
  subject?: string;
  [key: string]: unknown;
}

/**
 * Normalize the SendGrid public key into a CryptoKey-compatible PEM.
 * SendGrid stores the key as a single-line base64 string in the
 * webhook settings UI; we accept either that form or a full PEM
 * block so the env var can be set either way.
 */
function loadPublicKey(): ReturnType<typeof createPublicKey> | null {
  const raw = process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  if (!raw) return null;
  // If the key is already PEM-formatted, use it directly. Otherwise
  // wrap the base64 blob in PEM headers.
  const pem = raw.includes('-----BEGIN')
    ? raw.replace(/\\n/g, '\n')
    : `-----BEGIN PUBLIC KEY-----\n${raw.match(/.{1,64}/g)?.join('\n') ?? raw}\n-----END PUBLIC KEY-----`;
  try {
    return createPublicKey(pem);
  } catch (err) {
    console.error('[sendgrid-webhook] invalid SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY:', err);
    return null;
  }
}

function verifySignature(
  rawBody: string,
  signatureB64: string | null,
  timestampHeader: string | null,
): boolean {
  const pubKey = loadPublicKey();
  if (!pubKey || !signatureB64 || !timestampHeader) return false;

  // Replay protection: SendGrid timestamps are unix seconds. Reject
  // anything more than 10 minutes off our clock — that window is
  // enough to absorb clock skew + retry-storms but not a captured-
  // payload replay days later.
  const ts = parseInt(timestampHeader, 10);
  if (!Number.isFinite(ts)) return false;
  const skewMs = Math.abs(Date.now() - ts * 1000);
  if (skewMs > 10 * 60 * 1000) {
    console.warn(`[sendgrid-webhook] timestamp skew ${skewMs}ms > 10min — rejecting`);
    return false;
  }

  const signedPayload = Buffer.from(timestampHeader + rawBody, 'utf8');
  const signature = Buffer.from(signatureB64, 'base64');

  try {
    const verifier = createVerify('sha256');
    verifier.update(signedPayload);
    verifier.end();
    return verifier.verify(
      { key: pubKey, dsaEncoding: 'der' },
      signature,
    );
  } catch (err) {
    console.error('[sendgrid-webhook] signature verify threw:', err);
    return false;
  }
}

export async function POST(request: NextRequest) {
  // Read the raw body BEFORE parsing — signature is over raw bytes.
  // request.text() reads the underlying stream once; we re-parse with
  // JSON.parse below.
  const rawBody = await request.text();

  const signature = request.headers.get('x-twilio-email-event-webhook-signature');
  const timestamp = request.headers.get('x-twilio-email-event-webhook-timestamp');

  if (!verifySignature(rawBody, signature, timestamp)) {
    // Returning 401 makes SendGrid retry — which is fine; if our env
    // var is misconfigured we want to find out via SendGrid's retry
    // queue rather than silently dropping events.
    return NextResponse.json({ error: 'invalid signature' }, { status: 401 });
  }

  let events: SendGridEvent[];
  try {
    events = JSON.parse(rawBody);
    if (!Array.isArray(events)) throw new Error('payload not an array');
  } catch (err) {
    return NextResponse.json(
      { error: 'invalid JSON', details: err instanceof Error ? err.message : 'parse failed' },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();

  // Map SendGrid's event shape onto our table. Batched insert with
  // onConflict on sg_event_id makes replays a no-op (the table has a
  // unique index on sg_event_id; we use ignoreDuplicates: true so
  // PostgreSQL skips dup rows silently).
  const rows = events.map(ev => {
    const cats =
      ev.category == null ? null
        : Array.isArray(ev.category) ? ev.category
          : [ev.category];
    return {
      sg_event_id: ev.sg_event_id,
      sg_message_id: ev.sg_message_id ?? null,
      email: (ev.email || '').toLowerCase(),
      event_type: ev.event,
      event_timestamp: new Date(ev.timestamp * 1000).toISOString(),
      url: typeof ev.url === 'string' ? ev.url : null,
      user_agent: typeof ev.useragent === 'string' ? ev.useragent : null,
      ip: typeof ev.ip === 'string' ? ev.ip : null,
      reason: typeof ev.reason === 'string' ? ev.reason : null,
      status: typeof ev.status === 'string' ? ev.status : null,
      category: cats,
      subject: typeof ev.subject === 'string' ? ev.subject : null,
      payload: ev as unknown,
    };
  });

  // Filter out rows missing the dedup key (shouldn't happen, but be defensive).
  const valid = rows.filter(r => r.sg_event_id && r.email);

  if (valid.length === 0) {
    return NextResponse.json({ accepted: 0, skipped: rows.length });
  }

  // Supabase's `upsert` with `ignoreDuplicates: true` resolves to
  // INSERT ... ON CONFLICT DO NOTHING — exactly the semantic we want
  // for idempotent replay.
  const { error } = await (supabase
    .from('sendgrid_events' as any) as any)
    .upsert(valid, { onConflict: 'sg_event_id', ignoreDuplicates: true });

  if (error) {
    console.error('[sendgrid-webhook] DB insert failed:', error);
    // Return 500 so SendGrid retries the batch (it will, automatically).
    return NextResponse.json({ error: 'insert failed', details: error.message }, { status: 500 });
  }

  return NextResponse.json({ accepted: valid.length });
}
