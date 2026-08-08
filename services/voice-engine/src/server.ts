/**
 * HTTP + websocket entrypoint.
 *
 *  POST /calls              → place an outbound PPS call for { sessionId }
 *  POST /twiml/inbound      → TwiML for an inbound IRS callback (Twilio hits this)
 *  WS   /relay              → ConversationRelay bridge (one per call leg)
 *  GET  /healthz
 *
 * Deploys as one container; keep it small.
 */

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import twilio from 'twilio';
import { CONFIG } from './config';
import { CallHandler } from './call-handler';
import { outboundTwiml, inboundTwiml, RelayInbound } from './twilio-protocol';
import { db } from './session';

const twilioClient = twilio(CONFIG.twilioAccountSid, CONFIG.twilioAuthToken);
const PPS_NUMBER = process.env.IRS_PPS_NUMBER || '+18008609544'; // PPS line

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }

  if (req.method === 'POST' && req.url === '/calls') {
    const body = await readJson(req);
    const sessionId = body?.sessionId;
    if (!sessionId) return json(res, 400, { error: 'sessionId required' });
    try {
      // Assign an AI pool number as caller ID, then dial PPS and bridge to us.
      const from = await claimPoolNumber(sessionId);
      const call = await twilioClient.calls.create({
        to: PPS_NUMBER,
        from,
        twiml: outboundTwiml(`${CONFIG.publicWsUrl}/relay?session=${sessionId}`, { sessionId }),
      });
      await db().from('irs_call_sessions').update({
        status: 'in_progress', from_number: from, initiated_at: new Date().toISOString(),
      }).eq('id', sessionId);
      return json(res, 200, { ok: true, callSid: call.sid, from });
    } catch (e: any) {
      return json(res, 500, { error: e?.message || String(e) });
    }
  }

  if (req.method === 'POST' && req.url?.startsWith('/twiml/inbound')) {
    // Twilio Voice webhook for a pool number the IRS is calling back.
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(inboundTwiml(`${CONFIG.publicWsUrl}/relay?inbound=1`));
    return;
  }

  res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: '/relay' });

wss.on('connection', (ws: WebSocket, req) => {
  const url = new URL(req.url || '', 'http://localhost');
  const inbound = url.searchParams.get('inbound') === '1';
  let handler: CallHandler | null = null;
  let sessionId = url.searchParams.get('session') || '';

  const send = (msg: any) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
  const tick = setInterval(() => handler?.onTick().catch(() => {}), 15000);

  ws.on('message', async (raw) => {
    let msg: RelayInbound;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // The first message is `setup`; for inbound legs it tells us which pool
    // number was called, which resolves the session.
    if (msg.type === 'setup') {
      if (inbound) sessionId = await resolveInboundSession(msg.to) || sessionId;
      if (!sessionId) { send({ type: 'end' }); return ws.close(); }
      try {
        handler = await CallHandler.create(sessionId, send, inbound);
      } catch (e: any) {
        console.error('[relay] handler create failed:', e?.message || e);
        send({ type: 'end' }); ws.close();
      }
      return;
    }
    await handler?.onMessage(msg).catch((e) => console.error('[relay] onMessage:', e?.message || e));
  });

  ws.on('close', () => clearInterval(tick));
});

/** Pick a free AI callback number from the pool and pin it to this session. */
async function claimPoolNumber(sessionId: string): Promise<string> {
  const { data } = await db().from('callback_numbers')
    .select('id, phone_number').eq('state', 'available').limit(1).maybeSingle();
  if (!data) throw new Error('no available callback number in pool');
  await db().from('callback_numbers')
    .update({ state: 'assigned', assigned_session_id: sessionId, assigned_at: new Date().toISOString() })
    .eq('id', data.id);
  await db().from('irs_call_sessions')
    .update({ callback_number_id: data.id }).eq('id', sessionId);
  return data.phone_number;
}

async function resolveInboundSession(calledNumber: string): Promise<string | null> {
  const { data } = await db().from('callback_numbers')
    .select('assigned_session_id').eq('phone_number', calledNumber).maybeSingle();
  return data?.assigned_session_id || null;
}

async function readJson(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
}
function json(res: http.ServerResponse, code: number, body: any) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const PORT = Number(process.env.PORT || 8080);
server.listen(PORT, () => console.log(`[voice-engine] listening on :${PORT}`));
