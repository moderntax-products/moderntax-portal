/**
 * GET /api/entity-notes/[entityId]/template
 *
 * Returns the suggested instruction template for this entity based on
 * its client + form_type. The EntityNotesThread admin UI calls this
 * once on open and surfaces an "📋 Apply [Client] default" button that
 * pre-fills the post body with the template.
 *
 * Template lookup precedence on clients.entity_instruction_templates:
 *   1. Exact form_type key match (e.g., "1120S")
 *   2. "default" fallback
 *   3. null (no template configured for this client)
 *
 * Variable substitution:
 *   {years}  → the entity's years[] joined as "2023-2025" if contiguous
 *              or "2023, 2024, 2025" otherwise. Mirrors the year-format
 *              fix shipped earlier today for the 8821 PDF cell-width bug.
 *
 * Driver: 2026-05-26 Matt feedback — "Centerstone SBA requests
 * ROA/Tax Return/Civil Penalties for most orders." Per-client
 * templating saves the per-entity retype.
 *
 * Auth: admin only (only admin uses templates; experts post status
 * updates from their own framing).
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServerRouteClient, createAdminClient } from '@/lib/supabase-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PageProps { params: Promise<{ entityId: string }> }

export async function GET(_request: NextRequest, { params }: PageProps) {
  try {
    const cookieStore = await cookies();
    const sb = createServerRouteClient(cookieStore);
    const { data: { user } } = await sb.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const { data: profile } = await sb.from('profiles').select('role').eq('id', user.id).single() as { data: { role: string } | null };
    if (profile?.role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 });

    const { entityId } = await params;
    const admin = createAdminClient();

    const { data: entity, error } = await admin.from('request_entities')
      .select(`id, form_type, years, requests!inner(client_id, clients(id, name, entity_instruction_templates))`)
      .eq('id', entityId).single() as { data: any; error: any };

    // Graceful degrade: if the column doesn't exist yet (migration not
    // applied) return null template so the UI just hides the button.
    if (error && /entity_instruction_templates|column .* does not exist|PGRST/i.test(error.message || '')) {
      return NextResponse.json({ template: null, migration_pending: true });
    }
    if (error || !entity) return NextResponse.json({ error: 'Entity not found' }, { status: 404 });

    const client = entity.requests?.clients;
    const templates = client?.entity_instruction_templates;
    if (!templates || typeof templates !== 'object') {
      return NextResponse.json({ template: null, client_name: client?.name || null });
    }

    // Pick template — exact form_type match, then default, then null
    const ft = (entity.form_type || '').trim();
    let raw: string | null = null;
    let resolvedKey: string | null = null;
    if (ft && typeof templates[ft] === 'string') {
      raw = templates[ft]; resolvedKey = ft;
    } else if (typeof templates.default === 'string') {
      raw = templates.default; resolvedKey = 'default';
    }

    if (!raw) {
      return NextResponse.json({ template: null, client_name: client?.name || null });
    }

    // Variable substitution: {years} → formatted year range
    const years = formatYears(entity.years || []);
    const filled = raw.replace(/\{years\}/g, years);

    return NextResponse.json({
      template: filled,
      client_name: client?.name || null,
      resolved_key: resolvedKey,
      form_type: ft || null,
    });
  } catch (err: any) {
    console.error('[entity-notes template GET]', err);
    return NextResponse.json({ error: err?.message || 'Server error' }, { status: 500 });
  }
}

/**
 * Format year list for instruction body. Mirrors formatYearsForSection3
 * from app/api/admin/entity/generate-8821-pdf — contiguous → "2023-2025",
 * non-contiguous → "2022, 2024, 2025".
 */
function formatYears(years: (string | number)[]): string {
  const nums = years.map((y) => parseInt(String(y), 10)).filter(Number.isFinite);
  if (nums.length === 0) return '(years TBD)';
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  if (sorted.length === 1) return String(sorted[0]);
  const contiguous = sorted.every((y, i) => i === 0 || y === sorted[i - 1] + 1);
  return contiguous ? `${sorted[0]}-${sorted[sorted.length - 1]}` : sorted.join(', ');
}
