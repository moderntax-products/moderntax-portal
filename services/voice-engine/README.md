# ModernTax Voice Engine

Custom IRS PPS call engine. Replaces Retell/Bland after both proved wrong for
the shape of an IRS call (2026-07-22, Matt: "Retell sucked — we need something
customized to the real experience: navigating IVR, speaking to IRS agents,
holding").

## Why custom

Real PPS calls (see `/admin/pps-meter`) are ~62% dead wait. A managed
voice-agent platform runs an LLM agent for the entire call, which is wrong
three ways:

1. **IVR** — the PPS tree is known and stable. Pressing 2-then-1 and keying a
   CAF number is a state machine, not a conversation. LLM IVR nav is flaky
   and slow.
2. **Hold** — 30–90 minutes of hold music. The platform bills agent rates to
   listen to it, hold music confuses the agent into speaking, and platform
   max-call-duration caps kill exactly the calls that waited longest (the
   65-minute drop of 2026-07-22 is the canonical case).
3. **Agent conversation** — the only part that needs an LLM, and it's highly
   structured: verify (CAF/name/address/SOR), request transcripts, take a fax
   number, send the 8821 mid-call, confirm receipt.

This engine gives each phase its own machinery and keeps the LLM asleep until
a human is actually on the line.

## Architecture

```
Twilio Programmable Voice + ConversationRelay
        │ websocket (this service)
        ▼
┌─ Phase A: IVR navigator ─────────── deterministic DTMF plan, no LLM
├─ Phase B: hold sentinel ──────────── transcript-pattern watcher, LLM asleep
└─ Phase C: agent loop ─────────────── Claude (streaming, tools, caching)
        │
        ├─ tools: send_fax (existing Sinch endpoint), checkpoint, end_call
        └─ checkpoints → irs_call_sessions (verified_at, fax_sent_at, …)
```

**Checkpointed resume is native.** Every phase transition and tool call writes
a checkpoint. A drop after the fax means the retry call opens with "confirming
receipt of an 8821 faxed at HH:MM under CAF …" — a short call, not a fresh
65-minute cycle.

**Reused from the portal (nothing thrown away):**
- `callback_numbers` pool + state machine (waiting → imminent → answered)
- `/api/webhook/twilio-callback-sms` — the IRS "you're next" text
- `irs_call_sessions` schema, `lib/irs-pps-signal-extractor`, `lib/irs-call-classifier`
- `/api/expert/irs-call/mid-call-fax` — the Sinch fax bridge
- `lib/irs-callback-resume` context loading (expert creds, CAF, SOR)

Inbound IRS callbacks hit the same service: Twilio number → `/twiml/inbound`
→ session looked up by called number → Phase C directly, with resume context.

## Why a separate service

ConversationRelay needs a long-lived websocket; Vercel serverless can't hold
one. This deploys as one small container (Fly.io/Railway). The portal stays on
Vercel; the two share only Supabase and HTTPS calls to portal endpoints.

## Deploy

1. `fly launch` (Dockerfile included), set secrets from `.env.example`
2. Buy/verify 2–3 Twilio numbers (voice+SMS). Point their Voice webhook at
   `https://<app>/twiml/inbound`, SMS webhook at the portal's
   `/api/webhook/twilio-callback-sms`. Register them in `callback_numbers`.
3. Fire a call: `POST /calls` with `{ sessionId }`.

## Honest status

- Twilio ConversationRelay message shapes in `src/twilio-protocol.ts` are
  isolated in one file and must be verified against current Twilio docs
  before first deploy — the wire contract is theirs, not ours.
- The IVR DTMF plan in `src/ivr.ts` encodes the PPS tree as observed on real
  calls (May 2026 recordings); verify on the first live call — the IRS does
  change it.
