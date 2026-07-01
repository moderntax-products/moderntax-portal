/**
 * Token-gated Direct customer chat/notes — /api/public/direct-notes/[token]
 *
 * Lets a ModernTax Direct customer ask questions about their estimates/case
 * WITHOUT logging in, via the same signed entity token as their intake/review
 * link. GET returns the customer-visible thread (their questions + ModernTax's
 * replies); POST posts a new question. Questions land as entity_notes
 * (author_role='direct_user', kind='question') — the admin support agent already
 * triages + answers those (shadow-gated), and admins can reply in-portal.
 *
 * Internal expert/admin ops notes ('instruction', expert-authored) are never
 * exposed to the customer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase-server';
import { verifyFilingIntakeToken } from '@/lib/intake-tokens';

export const runtime = 'nodejs';

const CUSTOMER_VISIBLE_KINDS = ['question', 'answer', 'note', 'support'];

export async function GET(_request: NextRequest, { params }: { params: { token: string } }) {
  const entityId = verifyFilingIntakeToken(params.token);
  if (!entityId) return NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 });
  const admin = createAdminClient();
  const { data: notes } = await (admin.from('entity_notes' as any) as any)
    .select('author_role, author_name, body, kind, created_at')
    .eq('entity_id', entityId)
    .in('author_role', ['direct_user', 'admin'])
    .in('kind', CUSTOMER_VISIBLE_KINDS)
    .order('created_at', { ascending: true }) as { data: any[] | null };
  // Present ModernTax replies under a friendly name, the customer's own as "You".
  const thread = (notes || []).map((n) => ({
    from: n.author_role === 'direct_user' ? 'you' : 'moderntax',
    name: n.author_role === 'direct_user' ? 'You' : 'ModernTax',
    body: n.body,
    created_at: n.created_at,
  }));
  return NextResponse.json({ notes: thread });
}

export async function POST(request: NextRequest, { params }: { params: { token: string } }) {
  const entityId = verifyFilingIntakeToken(params.token);
  if (!entityId) {
    try {
      const admin = createAdminClient();
      const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
      await (admin.from('audit_log' as any) as any).insert({
        user_email: null, action: 'direct_notes_bad_token', entity_type: 'request_entity', entity_id: null,
        details: { token_prefix: (params.token || '').slice(0, 6) }, ip_address: ip,
      });
    } catch { /* best-effort */ }
    return NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 });
  }

  const body = await request.json().catch(() => ({} as any));
  const text = (body?.body || '').trim();
  if (!text) return NextResponse.json({ error: 'message required' }, { status: 400 });
  if (text.length > 2000) return NextResponse.json({ error: 'message too long (2000 max)' }, { status: 400 });

  const admin = createAdminClient();
  const { data: entity } = await admin.from('request_entities')
    .select('id, entity_name, signer_first_name, signer_last_name, requests!inner(client_id)')
    .eq('id', entityId).single() as { data: any };
  if (!entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

  // Resolve the Direct user (author_id lets the support agent email a reply).
  const { data: du } = await admin.from('profiles')
    .select('id').eq('client_id', entity.requests?.client_id).eq('role', 'direct_user').limit(1).maybeSingle() as { data: any };
  const name = [entity.signer_first_name, entity.signer_last_name].filter(Boolean).join(' ') || entity.entity_name;

  const { error } = await (admin.from('entity_notes' as any) as any).insert({
    entity_id: entityId, author_id: du?.id || null, author_role: 'direct_user',
    author_name: name, body: text, kind: 'question',
  });
  if (error) return NextResponse.json({ error: 'Could not post your question', detail: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
