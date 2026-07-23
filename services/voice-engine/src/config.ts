/**
 * Config — all from env. No secrets in code. Mirrors the portal's Vercel vars
 * plus the two Twilio numbers/creds this service adds.
 */

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const CONFIG = {
  // Claude
  anthropicApiKey: req('ANTHROPIC_API_KEY'),

  // Supabase (same project as the portal)
  supabaseUrl: req('NEXT_PUBLIC_SUPABASE_URL'),
  supabaseServiceKey: req('SUPABASE_SERVICE_ROLE_KEY'),

  // Twilio
  twilioAccountSid: req('TWILIO_ACCOUNT_SID'),
  twilioAuthToken: req('TWILIO_AUTH_TOKEN'),

  // The portal's existing Sinch mid-call fax bridge — we call it, we don't
  // re-implement faxing. Needs an internal shared secret so this service can
  // invoke it server-to-server.
  portalBaseUrl: process.env.PORTAL_BASE_URL || 'https://portal.moderntax.io',
  portalInternalSecret: req('VOICE_ENGINE_INTERNAL_SECRET'),

  // This service's own public wss:// URL, handed to Twilio in the TwiML.
  publicWsUrl: req('VOICE_ENGINE_WS_URL'),

  // Per-call safety cap. Set WELL above worst-case IRS hold (2h+). The
  // platform max-duration cap killing long holds is the exact failure this
  // engine exists to avoid, so this is a backstop against a wedged socket,
  // not a normal-operation limit.
  maxCallSeconds: Number(process.env.VOICE_ENGINE_MAX_CALL_SECONDS || 10800), // 3h

  // Line-went-dead detector: no transcript for this long during hold ⇒ treat
  // as a drop and let the retry machinery take over.
  holdSilenceTimeoutSec: Number(process.env.VOICE_ENGINE_HOLD_SILENCE_SEC || 120),
};
