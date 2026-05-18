/**
 * POST /api/processor/ask
 *
 * Authenticated processor submits a question → AI answers via Claude
 * (server-side call, key never reaches browser) → row inserted into
 * processor_questions with the Q+A pair → response returned to UI.
 *
 * If the AI flags should_escalate=true OR the AI service is unavailable,
 * an email pings admin@moderntax.io with the question + context so it
 * doesn't sit in the table waiting for someone to notice.
 *
 * Body: { question: string, entityId?: string, requestId?: string }
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';
import { logAuditFromRequest } from '@/lib/audit';
import { askProcessorAI } from '@/lib/processor-ai';
import { parseJsonBodyOrRespond } from '@/lib/request-body';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerRouteClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

  const { data: profile } = await supabase
    .from('profiles').select('role, client_id, email').eq('id', user.id).single() as { data: { role: string; client_id: string | null; email: string | null } | null };
  if (!profile) return NextResponse.json({ error: 'Profile not found' }, { status: 403 });
  // Open to all in-app roles (processor / manager / admin / expert / team_member)
  if (!['processor', 'manager', 'admin', 'expert', 'team_member'].includes(profile.role)) {
    return NextResponse.json({ error: 'Role not authorized' }, { status: 403 });
  }

  const parsed = await parseJsonBodyOrRespond<{ question?: string; entityId?: string; requestId?: string }>(request, 16 * 1024);
  if (parsed instanceof NextResponse) return parsed;
  const question = (parsed.question || '').trim();
  if (!question) return NextResponse.json({ error: 'question required' }, { status: 400 });
  if (question.length > 2000) return NextResponse.json({ error: 'question too long (max 2000 chars)' }, { status: 400 });

  const admin = createAdminClient();

  // Insert pending row first so we have a stable id for audit + escalation.
  // The table is brand-new (migration-processor-questions.sql) so the
  // generated database.types.ts doesn't know about it yet — cast to any.
  const { data: row, error: insErr } = await (admin.from('processor_questions' as any) as any)
    .insert({
      asked_by: user.id,
      asked_by_email: profile.email,
      client_id: profile.client_id,
      question_text: question,
      context_entity_id: parsed.entityId || null,
      context_request_id: parsed.requestId || null,
      status: 'pending_ai',
    })
    .select('id')
    .single() as { data: { id: string } | null; error: any };
  if (insErr || !row) {
    console.error('[processor/ask] insert failed:', insErr);
    return NextResponse.json({ error: 'Failed to log question', admin_hint: insErr?.message }, { status: 500 });
  }

  // Call AI
  const aiResult = await askProcessorAI(question);

  // Update the row with the AI response
  const newStatus = aiResult.shouldEscalate ? 'escalated' : 'answered_by_ai';
  await (admin.from('processor_questions' as any) as any)
    .update({
      ai_response: aiResult.answer,
      ai_model: aiResult.model,
      ai_response_at: new Date().toISOString(),
      ai_confidence: aiResult.confidence,
      status: newStatus,
      escalated_at: aiResult.shouldEscalate ? new Date().toISOString() : null,
      escalated_reason: aiResult.escalationReason,
    })
    .eq('id', row.id);

  // Audit log (SOC 2 CC7.2 — track every Q+A for retroactive review).
  // Re-using 'admin_access' as the closest existing AuditAction union
  // member; the details object carries the actual event kind. When the
  // AuditAction enum gets extended with 'processor_question_asked' this
  // can swap over cleanly.
  await logAuditFromRequest(admin, request, {
    action: 'admin_access',
    userId: user.id,
    userEmail: profile.email || '',
    resourceType: 'processor_question',
    resourceId: row.id,
    details: {
      kind: 'processor_question_asked',
      question_preview: question.slice(0, 80),
      ai_confidence: aiResult.confidence,
      ai_escalated: aiResult.shouldEscalate,
      ai_model: aiResult.model,
    },
  });

  // Email admin on escalation (best-effort, non-blocking)
  if (aiResult.shouldEscalate) {
    try {
      const { sendAdminFailureAlert } = await import('@/lib/sendgrid');
      await sendAdminFailureAlert(
        process.env.ADMIN_EMAIL || 'matt@moderntax.io',
        row.id,
        `Processor question needs review — from ${profile.email}\n\nQ: ${question}\n\nAI confidence: ${aiResult.confidence}\nEscalation reason: ${aiResult.escalationReason || 'n/a'}\n\nView at: /admin/processor-questions/${row.id}`,
      );
    } catch (emailErr) {
      console.warn('[processor/ask] escalation email failed (non-fatal):', emailErr);
    }
  }

  return NextResponse.json({
    questionId: row.id,
    answer: aiResult.answer,
    confidence: aiResult.confidence,
    escalated: aiResult.shouldEscalate,
    escalationReason: aiResult.escalationReason,
    fallback: !!aiResult.fallback,
  });
}
