/**
 * POST /api/webhook/twilio-callback-sms
 *
 * Twilio inbound-SMS webhook for the IRS callback handler. IRS texts the
 * callback number ~10 minutes before the agent calls. That text is our cue to
 * mark the session 'imminent' and pre-warm the AI resume-agent so it answers on
 * the first ring (IRS callbacks are effectively one-shot).
 *
 * Twilio posts application/x-www-form-urlencoded with To (our number) + From +
 * Body. Configure this URL as the number's Messaging webhook. Returns empty
 * TwiML so Twilio doesn't auto-reply.
 *
 * Auth: validates X-Twilio-Signature when TWILIO_AUTH_TOKEN is set.
 */
import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { findSessionByCallbackNumber } from '@/lib/callback-numbers';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const twiml = () => new NextResponse(EMPTY_TWIML, { status: 200, headers: { 'Content-Type': 'text/xml' } });

/** Twilio request signature validation (HMAC-SHA1 over URL + sorted POST params). */
function validTwilioSignature(url: string, params: Record<string, string>, signature: string, authToken: string): boolean {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const expected = crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature)); } catch { return false; }
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const params: Record<string, string> = {};
  form.forEach((v, k) => { params[k] = String(v); });

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (authToken) {
    const sig = request.headers.get('x-twilio-signature') || '';
    const url = process.env.TWILIO_CALLBACK_SMS_URL || request.url;
    if (!validTwilioSignature(url, params, sig, authToken)) {
      console.warn('[twilio-callback-sms] bad signature');
      return new NextResponse('Forbidden', { status: 403 });
    }
  }

  const to = params.To || '';        // our callback number IRS texted
  const from = params.From || '';
  const body = (params.Body || '').slice(0, 200);
  if (!to) return twiml();

  try {
    const admin = createAdminClient();
    const match = await findSessionByCallbackNumber(admin, to);
    if (!match) {
      console.log(`[twilio-callback-sms] inbound to ${to} from ${from} — no waiting session (ignored)`);
      return twiml();
    }
    await admin.from('irs_call_sessions' as any).update({
      callback_state: 'imminent',
      callback_sms_received_at: new Date().toISOString(),
    } as any).eq('id', match.sessionId);
    console.log(`[twilio-callback-sms] session ${match.sessionId} → imminent (IRS texted ${to}: "${body}")`);
    // TODO(next): pre-warm the AI resume-agent for match.sessionId so it answers
    //   on ring 1 (provider-specific; part of the inbound-voice build).
  } catch (e) {
    console.error('[twilio-callback-sms] handler error:', e instanceof Error ? e.message : e);
  }
  return twiml();
}
