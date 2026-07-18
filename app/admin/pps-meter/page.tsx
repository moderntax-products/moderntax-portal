'use client';

/**
 * PPS Call Meter — operator console (Metered AI Call pilot, spec v0.1, task 3).
 *
 * A live stopwatch that decomposes a real IRS PPS call into its segments and
 * captures human_attached_sec — the money metric — so we can measure cost/entity
 * against the 51.3 min/entity baseline. Works fully manual (no Twilio) so the
 * control-group baseline can be recorded Monday regardless of the AI build.
 *
 * No PII is entered here — only durations, request/entity ids, and outcome.
 */

import { useEffect, useRef, useState } from 'react';

const SEGMENTS = [
  { key: 'dial_to_ivr_sec', label: 'Dial → IVR', hint: 'connecting', auto: false },
  { key: 'ivr_nav_sec', label: 'IVR nav', hint: 'phone tree', auto: false },
  { key: 'queue_wait_sec', label: 'Queue wait', hint: 'pre-agent · automatable', auto: true },
  { key: 'total_hold_sec', label: 'On hold', hint: 'mid-call · automatable', auto: true },
  { key: 'active_talk_sec', label: 'Active talk', hint: 'with agent', auto: false },
] as const;
type SegKey = (typeof SEGMENTS)[number]['key'];

const fmt = (s: number) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

export default function PpsMeterPage() {
  // ── call metadata ──
  const [client, setClient] = useState<'centerstone' | 'cal_statewide'>('centerstone');
  const [requestId, setRequestId] = useState('');
  const [entityIds, setEntityIds] = useState('');
  const [entitiesOnCall, setEntitiesOnCall] = useState(1);
  const [phase, setPhase] = useState<'manual' | 'phase0' | 'phase1' | 'phase2'>('manual');
  const [aiMinutes, setAiMinutes] = useState(0);
  const [faxRetries, setFaxRetries] = useState(0);
  const [faxConfirmed, setFaxConfirmed] = useState(false);

  // ── timer state ──
  const [running, setRunning] = useState(false);
  const [ended, setEnded] = useState(false);
  const [activeSeg, setActiveSeg] = useState<SegKey | null>(null);
  const [humanOn, setHumanOn] = useState(true);
  const [accum, setAccum] = useState<Record<SegKey, number>>({
    dial_to_ivr_sec: 0, ivr_nav_sec: 0, queue_wait_sec: 0, total_hold_sec: 0, active_talk_sec: 0,
  });
  const [humanAccum, setHumanAccum] = useState(0);
  const segStart = useRef<number | null>(null);
  const humanStart = useRef<number | null>(null);
  const callStart = useRef<number | null>(null);
  const [, setTick] = useState(0);

  // ── outcome (on end) ──
  const [outcome, setOutcome] = useState('completed');
  const [rejectionReason, setRejectionReason] = useState('');
  const [escalationTrigger, setEscalationTrigger] = useState('');
  const [notes, setNotes] = useState('');

  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [recent, setRecent] = useState<any>(null);

  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, [running]);

  const loadRecent = async () => {
    try {
      const r = await fetch('/api/admin/pps-meter');
      if (r.ok) setRecent(await r.json());
    } catch { /* non-fatal */ }
  };
  useEffect(() => { loadRecent(); }, []);

  const commitSeg = () => {
    if (activeSeg && segStart.current != null) {
      const add = (Date.now() - segStart.current) / 1000;
      setAccum((a) => ({ ...a, [activeSeg]: a[activeSeg] + add }));
    }
    segStart.current = Date.now();
  };
  const commitHuman = () => {
    if (humanOn && humanStart.current != null) {
      setHumanAccum((h) => h + (Date.now() - humanStart.current!) / 1000);
    }
    humanStart.current = Date.now();
  };

  const liveSeg = (k: SegKey) =>
    accum[k] + (activeSeg === k && segStart.current != null ? (Date.now() - segStart.current) / 1000 : 0);
  const liveHuman = () =>
    humanAccum + (humanOn && humanStart.current != null ? (Date.now() - humanStart.current) / 1000 : 0);
  const liveTotal = () => (callStart.current != null ? (Date.now() - callStart.current) / 1000 : 0);

  const startCall = () => {
    setResult(null); setError(null); setEnded(false);
    setAccum({ dial_to_ivr_sec: 0, ivr_nav_sec: 0, queue_wait_sec: 0, total_hold_sec: 0, active_talk_sec: 0 });
    setHumanAccum(0);
    const now = Date.now();
    callStart.current = now;
    segStart.current = now;
    humanStart.current = humanOn ? now : null;
    setActiveSeg('dial_to_ivr_sec');
    setRunning(true);
  };
  const switchSeg = (k: SegKey) => { commitSeg(); setActiveSeg(k); };
  const toggleHuman = () => { commitHuman(); setHumanOn((v) => { humanStart.current = !v ? Date.now() : null; return !v; }); };
  const endCall = () => { commitSeg(); commitHuman(); setRunning(false); setEnded(true); setActiveSeg(null); };

  const save = async () => {
    setSaving(true); setError(null);
    try {
      const payload = {
        client, request_id: requestId || null,
        entity_ids: entityIds.split(',').map((s) => s.trim()).filter(Boolean),
        entities_on_call: Math.max(1, Number(entitiesOnCall) || 1),
        phase,
        dial_to_ivr_sec: Math.round(accum.dial_to_ivr_sec),
        ivr_nav_sec: Math.round(accum.ivr_nav_sec),
        queue_wait_sec: Math.round(accum.queue_wait_sec),
        total_hold_sec: Math.round(accum.total_hold_sec),
        active_talk_sec: Math.round(accum.active_talk_sec),
        human_attached_sec: Math.round(humanAccum),
        total_call_sec: Math.round((callStart.current ? (Date.now() - callStart.current) / 1000 : 0)),
        ai_minutes: phase === 'manual' ? 0 : Number(aiMinutes) || 0,
        ai_provider: 'bland',
        fax_confirmed_at: faxConfirmed ? new Date().toISOString() : null,
        fax_sent_at: faxConfirmed ? new Date().toISOString() : null,
        fax_retries: Number(faxRetries) || 0,
        outcome,
        rejection_reason: rejectionReason || null,
        escalation_trigger: escalationTrigger || null,
        notes: notes || null,
      };
      const r = await fetch('/api/admin/pps-meter', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Save failed');
      setResult(data.derived);
      setEnded(false);
      setRequestId(''); setEntityIds(''); setRejectionReason(''); setEscalationTrigger(''); setNotes('');
      loadRecent();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const s = recent?.summary;
  const BASE_MIN = 51.3, BASE_COST = 41.49, TARGET = 20;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 20px', fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, margin: 0 }}>PPS Call Meter</h1>
      <p style={{ color: '#666', marginTop: 6, fontSize: 14 }}>
        Live-time each call segment. <strong>Human-attached</strong> is the money metric — baseline is{' '}
        <strong>51.3 min/entity</strong>, Phase-0 target is <strong>&lt;20</strong>. No PII — durations only.
      </p>

      {/* METADATA */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, margin: '18px 0', padding: 16, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fafafa' }}>
        <Field label="Client">
          <select value={client} onChange={(e) => setClient(e.target.value as any)} disabled={running} style={inp}>
            <option value="centerstone">Centerstone</option>
            <option value="cal_statewide">Cal Statewide</option>
          </select>
        </Field>
        <Field label="Request # (loan)"><input value={requestId} onChange={(e) => setRequestId(e.target.value)} placeholder="18058" style={inp} /></Field>
        <Field label="Entities on call"><input type="number" min={1} value={entitiesOnCall} onChange={(e) => setEntitiesOnCall(Number(e.target.value))} disabled={running} style={inp} /></Field>
        <Field label="Entity IDs (comma)"><input value={entityIds} onChange={(e) => setEntityIds(e.target.value)} placeholder="opt." style={inp} /></Field>
        <Field label="Phase">
          <select value={phase} onChange={(e) => setPhase(e.target.value as any)} disabled={running} style={inp}>
            <option value="manual">Manual (control)</option>
            <option value="phase0">Phase 0 (auto-wait)</option>
            <option value="phase1">Phase 1</option>
            <option value="phase2">Phase 2</option>
          </select>
        </Field>
        {phase !== 'manual' && <Field label="AI minutes"><input type="number" min={0} value={aiMinutes} onChange={(e) => setAiMinutes(Number(e.target.value))} style={inp} /></Field>}
      </div>

      {/* TIMER CONSOLE */}
      <div style={{ padding: 18, border: '2px solid ' + (running ? '#16a34a' : '#e5e7eb'), borderRadius: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: '.05em' }}>Total call</div>
            <div style={{ fontSize: 34, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{fmt(liveTotal())}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, color: '#888', textTransform: 'uppercase', letterSpacing: '.05em' }}>Human-attached</div>
            <div style={{ fontSize: 34, fontWeight: 800, color: '#b45309', fontVariantNumeric: 'tabular-nums' }}>{fmt(liveHuman())}</div>
          </div>
          {!running && !ended && <button onClick={startCall} style={{ ...btn, background: '#16a34a', color: '#fff', fontSize: 16, padding: '12px 22px' }}>▶ Start call</button>}
          {running && <button onClick={endCall} style={{ ...btn, background: '#dc2626', color: '#fff', fontSize: 16, padding: '12px 22px' }}>■ End call</button>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
          {SEGMENTS.map((seg) => (
            <button key={seg.key} onClick={() => running && switchSeg(seg.key)} disabled={!running}
              style={{
                ...btn, flexDirection: 'column', alignItems: 'flex-start', padding: '10px 12px', minHeight: 68,
                background: activeSeg === seg.key ? (seg.auto ? '#dbeafe' : '#dcfce7') : '#fff',
                border: '1px solid ' + (activeSeg === seg.key ? (seg.auto ? '#3b82f6' : '#16a34a') : '#e5e7eb'),
                cursor: running ? 'pointer' : 'default', opacity: running ? 1 : 0.7,
              }}>
              <span style={{ fontSize: 12, fontWeight: 700 }}>{seg.label}</span>
              <span style={{ fontSize: 10, color: seg.auto ? '#2563eb' : '#999' }}>{seg.hint}</span>
              <span style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{fmt(liveSeg(seg.key))}</span>
            </button>
          ))}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 13 }}>
          <input type="checkbox" checked={humanOn} onChange={toggleHuman} />
          <span><strong>Human attached</strong> — on while you&apos;re personally on the line (manual = whole call; Phase 0 = only during active talk)</span>
        </label>
      </div>

      {/* SAVE PANEL */}
      {ended && (
        <div style={{ marginTop: 16, padding: 16, border: '1px solid #e5e7eb', borderRadius: 10, background: '#fffbeb' }}>
          <h3 style={{ margin: '0 0 12px', fontSize: 15 }}>Log outcome &amp; save</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
            <Field label="Outcome">
              <select value={outcome} onChange={(e) => setOutcome(e.target.value)} style={inp}>
                <option value="completed">completed</option>
                <option value="irs_rejected">irs_rejected</option>
                <option value="disconnected">disconnected</option>
                <option value="escalated">escalated</option>
                <option value="agent_refused">agent_refused</option>
              </select>
            </Field>
            <Field label="Fax retries"><input type="number" min={0} value={faxRetries} onChange={(e) => setFaxRetries(Number(e.target.value))} style={inp} /></Field>
            {outcome === 'irs_rejected' && <Field label="Rejection reason"><input value={rejectionReason} onChange={(e) => setRejectionReason(e.target.value)} style={inp} /></Field>}
            {(outcome === 'escalated' || outcome === 'agent_refused') && <Field label="Escalation trigger"><input value={escalationTrigger} onChange={(e) => setEscalationTrigger(e.target.value)} style={inp} /></Field>}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, alignSelf: 'end' }}>
              <input type="checkbox" checked={faxConfirmed} onChange={(e) => setFaxConfirmed(e.target.checked)} /> Fax confirmed delivered
            </label>
          </div>
          <Field label="Notes (no PII)"><input value={notes} onChange={(e) => setNotes(e.target.value)} style={inp} /></Field>
          <button onClick={save} disabled={saving} style={{ ...btn, background: '#111', color: '#fff', marginTop: 12, padding: '10px 18px' }}>
            {saving ? 'Saving…' : 'Save metered call'}
          </button>
          {error && <p style={{ color: '#dc2626', fontSize: 13, marginTop: 8 }}>{error}</p>}
        </div>
      )}

      {/* RESULT */}
      {result && (
        <div style={{ marginTop: 16, padding: 16, border: '1px solid ' + (result.meets_phase0_target ? '#16a34a' : result.below_kill_line ? '#f59e0b' : '#dc2626'), borderRadius: 10 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 15 }}>Result vs baseline</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <Stat label="Human min / entity" value={result.human_attached_min_per_entity} sub={`base ${BASE_MIN} · Δ ${result.vs_baseline_min}`} good={result.human_attached_min_per_entity < TARGET} />
            <Stat label="Cost / entity" value={`$${result.cost_per_entity_usd}`} sub={`base $${BASE_COST} · Δ $${result.vs_baseline_cost}`} good={result.cost_per_entity_usd < 22} />
            <Stat label="Automatable wait" value={`${result.automatable_wait_pct}%`} sub={`${fmt(result.automatable_wait_sec)} of call`} />
            <Stat label="Total cost" value={`$${result.total_cost_usd}`} sub={`human $${result.human_cost_usd}`} />
          </div>
          <p style={{ fontSize: 12, color: result.below_kill_line ? '#16a34a' : '#dc2626', marginTop: 10 }}>
            {result.meets_phase0_target ? '✅ Meets the <20 min/entity Phase-0 target.'
              : result.below_kill_line ? '⚠️ Below baseline but above the 20-min target.'
              : '⛔ Above the 30-min kill line — cost model does not hold on this call.'}
          </p>
        </div>
      )}

      {/* PILOT SUMMARY */}
      {s && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ fontSize: 15, margin: '0 0 10px' }}>Pilot to date — {s.calls} calls · {s.entities} entities</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <Stat label="Avg human min/entity" value={s.avg_human_min_per_entity} sub={`base ${BASE_MIN}`} good={s.avg_human_min_per_entity < TARGET} />
            <Stat label="Avg cost/entity" value={`$${s.avg_cost_per_entity}`} sub={`base $${BASE_COST}`} good={s.avg_cost_per_entity < 22} />
            <Stat label="Completion" value={`${s.completion_rate}%`} sub="target ≥85%" good={s.completion_rate >= 85} />
            <Stat label="Fax 1st-attempt" value={`${s.fax_first_attempt_success_rate}%`} sub="target ≥95%" good={s.fax_first_attempt_success_rate >= 95} />
          </div>
          <div style={{ overflowX: 'auto', marginTop: 14, border: '1px solid #e5e7eb', borderRadius: 8 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640, fontSize: 12 }}>
              <thead><tr style={{ background: '#f9fafb', textAlign: 'left' }}>
                {['When', 'Client', 'Req', 'Ent', 'Human m/ent', '$/ent', 'Wait%', 'Outcome'].map((h) => <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {(recent?.calls || []).slice(0, 15).map((c: any) => {
                  const hm = c.entities_on_call ? Math.round((c.human_attached_sec / c.entities_on_call / 60) * 10) / 10 : 0;
                  const cpe = c.entities_on_call ? Math.round((c.total_cost_usd / c.entities_on_call) * 100) / 100 : 0;
                  const wait = c.total_call_sec ? Math.round(((c.queue_wait_sec + c.total_hold_sec) / c.total_call_sec) * 100) : 0;
                  return (
                    <tr key={c.call_id} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={td}>{new Date(c.started_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                      <td style={td}>{c.client}</td><td style={td}>{c.request_id || '—'}</td><td style={td}>{c.entities_on_call}</td>
                      <td style={{ ...td, fontWeight: 700, color: hm < TARGET ? '#16a34a' : '#b45309' }}>{hm}</td>
                      <td style={td}>${cpe}</td><td style={td}>{wait}%</td><td style={td}>{c.outcome}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const inp: React.CSSProperties = { width: '100%', padding: '7px 9px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 13 };
const btn: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 8, fontWeight: 600, cursor: 'pointer' };
const th: React.CSSProperties = { padding: '7px 10px', fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' };
const td: React.CSSProperties = { padding: '7px 10px', whiteSpace: 'nowrap' };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block', fontSize: 12 }}>
      <span style={{ display: 'block', color: '#6b7280', marginBottom: 3, fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}
function Stat({ label, value, sub, good }: { label: string; value: React.ReactNode; sub?: string; good?: boolean }) {
  return (
    <div style={{ padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8 }}>
      <div style={{ fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: good == null ? '#111' : good ? '#16a34a' : '#b45309' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af' }}>{sub}</div>}
    </div>
  );
}
