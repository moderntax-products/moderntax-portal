/**
 * The per-call state machine: one ConversationRelay websocket, driven through
 * Phase A (IVR) → Phase B (hold sentinel) → Phase C (agent), with checkpoints
 * at every transition so a drop resumes instead of restarting.
 *
 * The LLM (agent.ts) is invoked ONLY in Phase C. Phases A and B are pure
 * pattern/DTMF logic — that separation is the entire cost and reliability
 * argument for building this instead of renting a managed voice agent.
 */

import type { RelayInbound, RelayOutbound } from './twilio-protocol';
import { PPS_IVR_PLAN, HOLD_STARTED_MARKERS, OVERFLOW_MARKERS, CALLBACK_OFFER_MARKERS, fillCaf, matchesAny } from './ivr';
import { HoldSentinel } from './sentinel';
import { buildSystemPrompt, runAgentTurn, appendTurn, AgentTool } from './agent';
import { CallSession, checkpoint, loadSession, markCallEnded, resumeBrief } from './session';
import { sendFaxViaPortal } from './portal-client';
import { CONFIG } from './config';
import type Anthropic from '@anthropic-ai/sdk';

type Phase = 'ivr' | 'hold' | 'agent' | 'ended';
type Send = (msg: RelayOutbound) => void;

export class CallHandler {
  private phase: Phase = 'ivr';
  private ivrIndex = 0;
  private ivrDeadline = Date.now() + PPS_IVR_PLAN[0].timeoutSec * 1000;
  private sentinel = new HoldSentinel();
  private transcriptWindow = '';
  private startedAt = Date.now();

  // Phase C state
  private system: Anthropic.TextBlockParam[] = [];
  private messages: Anthropic.MessageParam[] = [];
  private agentBusy = false;

  private constructor(
    private session: CallSession,
    private send: Send,
    /** Inbound resumed calls skip the IVR — the IRS already dialed us. */
    private inboundResume: boolean,
  ) {}

  static async create(sessionId: string, send: Send, inboundResume: boolean): Promise<CallHandler> {
    const session = await loadSession(sessionId);
    const h = new CallHandler(session, send, inboundResume);
    if (inboundResume) {
      // The IRS called our pool number back — a human is (about to be) on the
      // line. Go straight to Phase C with the resume brief already in context.
      h.phase = 'agent';
      await checkpoint(session, 'agent_reached', 'inbound callback');
      h.startAgent();
    } else {
      await checkpoint(session, 'dialing');
    }
    return h;
  }

  /** Every ConversationRelay message lands here. */
  async onMessage(msg: RelayInbound): Promise<void> {
    if (this.phase === 'ended') return;

    if (msg.type === 'error') {
      console.error(`[call ${this.session.id.slice(0, 8)}] relay error: ${msg.description}`);
      return this.end('relay_error');
    }
    if (this.overCap()) return this.end('max_duration_backstop');

    if (msg.type === 'prompt') {
      const text = msg.voicePrompt || '';
      this.transcriptWindow = (this.transcriptWindow + ' ' + text).slice(-4000);
      switch (this.phase) {
        case 'ivr': return this.handleIvr(text);
        case 'hold': return this.handleHold(text);
        case 'agent': return this.handleAgent(text, msg.last);
      }
    }
  }

  // ── Phase A ────────────────────────────────────────────────────────────
  private async handleIvr(_text: string): Promise<void> {
    const step = PPS_IVR_PLAN[this.ivrIndex];

    // Overflow / callback offers can appear during or right after the IVR.
    if (matchesAny(this.transcriptWindow, OVERFLOW_MARKERS)) {
      await checkpoint(this.session, 'overflow_rejected');
      return this.end('overflow_rejected');
    }
    if (matchesAny(this.transcriptWindow, CALLBACK_OFFER_MARKERS)) {
      // Accept the callback: press the offered key (PPS uses 1), checkpoint,
      // and let the line drop — the inbound webhook resumes us later.
      await checkpoint(this.session, 'callback_accepted');
      this.send({ type: 'sendDigits', digits: '1' });
      return this.end('callback_offered');
    }

    if (step && matchesAny(this.transcriptWindow, step.match)) {
      const digits = fillCaf(step.digits, this.session.caf);
      if (digits) this.send({ type: 'sendDigits', digits });
      await checkpoint(this.session, step.label as any);
      this.ivrIndex += 1;
      this.transcriptWindow = '';
      if (this.ivrIndex >= PPS_IVR_PLAN.length) {
        this.phase = 'hold';
        await checkpoint(this.session, 'hold_started');
      } else {
        this.ivrDeadline = Date.now() + PPS_IVR_PLAN[this.ivrIndex].timeoutSec * 1000;
      }
      return;
    }

    if (Date.now() > this.ivrDeadline) {
      // Menu didn't match in time — the tree likely changed. Bail retryably.
      await checkpoint(this.session, 'ivr_lost', `stuck at step ${this.ivrIndex}`);
      return this.end('ivr_lost');
    }
  }

  // ── Phase B ────────────────────────────────────────────────────────────
  private async handleHold(text: string): Promise<void> {
    // Still hearing "please continue to hold" style content keeps us here;
    // the sentinel decides when a human has actually arrived.
    if (matchesAny(text, HOLD_STARTED_MARKERS)) return;
    const verdict = this.sentinel.observe(text);
    if (verdict.humanDetected) {
      this.phase = 'agent';
      await checkpoint(this.session, 'agent_reached', verdict.trigger?.slice(0, 80));
      this.startAgent();
      // The human's opening line IS the first thing for the agent to answer.
      return this.handleAgent(text, true);
    }
  }

  // ── Phase C ────────────────────────────────────────────────────────────
  private startAgent(): void {
    this.system = buildSystemPrompt(this.session);
    this.messages = [];
  }

  private async handleAgent(text: string, last: boolean): Promise<void> {
    if (!last || this.agentBusy) return; // wait for a complete utterance; one turn at a time
    const clean = text.trim();
    if (!clean) return;

    this.agentBusy = true;
    try {
      this.messages.push({ role: 'user', content: clean });
      await this.driveAgent();
    } catch (e: any) {
      console.error(`[call ${this.session.id.slice(0, 8)}] agent turn failed:`, e?.message || e);
    } finally {
      this.agentBusy = false;
    }
  }

  /**
   * Generate turns until the model stops calling tools. A caller utterance
   * usually produces one turn; a fax mid-call produces two (the tool call,
   * then the model's spoken follow-up after the tool result). Bounded so a
   * misbehaving model can't loop forever on one utterance.
   */
  private async driveAgent(): Promise<void> {
    for (let hop = 0; hop < 5; hop++) {
      const turn = await runAgentTurn(this.system, this.messages, (tok) =>
        this.send({ type: 'text', token: tok, last: false }),
      );
      this.send({ type: 'text', token: '', last: true }); // flush TTS

      const assistantBlocks: Anthropic.ContentBlockParam[] = [];
      if (turn.spoken) assistantBlocks.push({ type: 'text', text: turn.spoken });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of turn.toolCalls) {
        assistantBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
        results.push(await this.runTool(call));
      }
      appendTurn(this.messages, assistantBlocks, results);

      if (turn.done) return this.end('completed');
      if (results.length === 0) return; // no tool ran → turn is complete, wait for the caller
      // A tool ran: loop so the model reacts to the result (e.g. speaks after faxing).
    }
  }

  private async runTool(call: AgentTool): Promise<Anthropic.ToolResultBlockParam> {
    try {
      if (call.name === 'send_fax') {
        const entity = this.session.entities[call.input.entity_index];
        if (!entity) return this.toolErr(call.id, 'No entity at that index.');
        const res = await sendFaxViaPortal(this.session.id, entity.id, call.input.fax_number);
        await checkpoint(this.session, 'fax_sent', `${entity.name} → ${call.input.fax_number}`);
        return { type: 'tool_result', tool_use_id: call.id, content: res.ok ? 'Fax sent successfully.' : `Fax failed: ${res.error}` };
      }
      if (call.name === 'record_progress') {
        const map: Record<string, any> = {
          verified: 'verified', forms_requested: 'forms_requested',
          fax_confirmed: 'fax_confirmed', delivery_committed: 'delivery_committed',
        };
        await checkpoint(this.session, map[call.input.milestone], call.input.detail);
        return { type: 'tool_result', tool_use_id: call.id, content: 'Recorded.' };
      }
      if (call.name === 'end_call') {
        return { type: 'tool_result', tool_use_id: call.id, content: 'Ending call.' };
      }
    } catch (e: any) {
      return this.toolErr(call.id, e?.message || String(e));
    }
    return this.toolErr(call.id, 'Unknown tool.');
  }

  private toolErr(id: string, msg: string): Anthropic.ToolResultBlockParam {
    return { type: 'tool_result', tool_use_id: id, content: msg, is_error: true };
  }

  private overCap(): boolean {
    return (Date.now() - this.startedAt) / 1000 > CONFIG.maxCallSeconds;
  }

  private async end(outcome: string): Promise<void> {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    await checkpoint(this.session, 'call_ended', outcome);
    await markCallEnded(this.session, outcome, (Date.now() - this.startedAt) / 1000);
    this.send({ type: 'end', handoffData: outcome });
  }

  /** Called by the socket layer on a tick to catch a dead hold line. */
  async onTick(): Promise<void> {
    if (this.phase === 'hold' && this.sentinel.silenceSeconds() > CONFIG.holdSilenceTimeoutSec) {
      await checkpoint(this.session, 'call_ended', 'hold_line_dead');
      return this.end('hold_dropped');
    }
  }
}
