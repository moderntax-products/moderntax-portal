'use client';

import { useState, useEffect, useCallback } from 'react';

interface Msg { from: 'you' | 'moderntax'; name: string; body: string; created_at: string }

/**
 * Direct customer chat/notes — a token-gated "ask your ModernTax team" thread.
 * No login: reads/writes /api/public/direct-notes/[token]. Questions are triaged
 * + answered by the admin support agent (and admins in-portal); replies appear
 * here on refresh.
 */
export function DirectQuestions({ token }: { token: string }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/public/direct-notes/${token}`, { cache: 'no-store' });
      if (r.ok) setMsgs((await r.json()).notes || []);
    } catch { /* offline — leave as-is */ }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const r = await fetch(`/api/public/direct-notes/${token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
      });
      if (r.ok) { setText(''); setSent(true); await load(); }
    } finally { setSending(false); }
  };

  const fmt = (iso: string) => { try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

  return (
    <section style={{ maxWidth: 720, margin: '24px auto 0', padding: '0 4px' }}>
      <h2 style={{ fontSize: 18, margin: '8px 0' }}>Questions about your review?</h2>
      <p style={{ color: '#5e554b', fontSize: 14, marginTop: 0 }}>Message your ModernTax team directly — ask anything about your estimates, the years, or next steps. We&rsquo;ll reply here.</p>

      <div style={{ background: '#fff', border: '1px solid #e4dcd0', borderRadius: 12, padding: 16, margin: '12px 0' }}>
        {msgs.length === 0 ? (
          <p style={{ color: '#8a8073', fontSize: 14, margin: 0 }}>No messages yet — send the first one below.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {msgs.map((m, i) => (
              <div key={i} style={{ alignSelf: m.from === 'you' ? 'flex-end' : 'flex-start', maxWidth: '85%' }}>
                <div style={{ background: m.from === 'you' ? '#8a2433' : '#f3efe8', color: m.from === 'you' ? '#fff' : '#211c17', borderRadius: 10, padding: '9px 13px', fontSize: 14.5, whiteSpace: 'pre-wrap' }}>{m.body}</div>
                <div style={{ fontSize: 11, color: '#8a8073', marginTop: 3, textAlign: m.from === 'you' ? 'right' : 'left' }}>{m.name} · {fmt(m.created_at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <textarea value={text} onChange={(e) => { setText(e.target.value); setSent(false); }} placeholder="Type your question…" rows={3}
        style={{ width: '100%', border: '1px solid #d8cfc1', borderRadius: 10, padding: '10px 12px', fontSize: 15, fontFamily: 'inherit', resize: 'vertical' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <button onClick={send} disabled={sending || !text.trim()}
          style={{ background: '#8a2433', color: '#fff', border: 0, borderRadius: 10, padding: '11px 22px', fontSize: 15, fontWeight: 600, cursor: sending || !text.trim() ? 'default' : 'pointer', opacity: sending || !text.trim() ? 0.5 : 1 }}>
          {sending ? 'Sending…' : 'Send'}
        </button>
        {sent && <span style={{ color: '#2f6e4f', fontSize: 13.5 }}>✓ Sent — we&rsquo;ll get back to you shortly.</span>}
      </div>
    </section>
  );
}
