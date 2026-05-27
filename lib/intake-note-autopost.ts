/**
 * Auto-create the initial instruction note on each entity at intake.
 *
 * Driver: 2026-05-27 Matt — "We really need this to be dialed in
 * between the request (specifically what is requested by the processor)
 * directly to the expert so there is no admin back and forth natively."
 *
 * When CSV / manual / PDF intake creates entities, this helper fires
 * once per entity to write an `instruction` note that captures:
 *   - The form + years + entity name
 *   - The client's standard instruction template (if configured —
 *     e.g., Centerstone's ROA + Tax Return + Civil Penalties block)
 *   - Free-text processor notes from the intake payload (if any)
 *
 * Author = the processor who submitted the intake (so the thread
 * shows "Soobin Song requested: ROA + Tax Return..."). Expert sees
 * this immediately on their dashboard — no admin relay needed.
 *
 * Best-effort: failures are logged but don't fail the intake itself.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface IntakeNoteInput {
  entityId: string;
  entityName: string;
  formType: string | null;
  years: (string | number)[] | null;
  requesterUserId: string;
  requesterName: string;
  requesterRole: 'admin' | 'expert' | 'processor' | 'manager';
  clientId: string;
  /** Optional free-text from the intake payload (per-entity or whole-request). */
  freeTextNotes?: string | null;
}

export async function autoPostIntakeNote(
  admin: SupabaseClient,
  input: IntakeNoteInput,
): Promise<{ posted: boolean; reason?: string }> {
  try {
    // Don't post if this entity already has any notes (avoids duplicate
    // intake instructions on re-runs, repeat-entity flows, etc.)
    const { count: existingCount } = await (admin.from('entity_notes' as any) as any)
      .select('id', { count: 'exact', head: true })
      .eq('entity_id', input.entityId);
    if ((existingCount || 0) > 0) {
      return { posted: false, reason: 'notes already exist on entity' };
    }

    // Pull the client's template (may be null if no template configured)
    const { data: client } = await admin.from('clients')
      .select('name, entity_instruction_templates')
      .eq('id', input.clientId).single() as { data: any };

    const templates = client?.entity_instruction_templates || {};
    const ft = (input.formType || '').trim();
    let templateBody: string | null = null;
    if (ft && typeof templates[ft] === 'string') templateBody = templates[ft];
    else if (typeof templates.default === 'string') templateBody = templates.default;

    // Format years for substitution
    const years = formatYears(input.years || []);

    // Build the note body
    const lines: string[] = [];
    lines.push(`[INTAKE — auto-generated from ${input.requesterRole === 'processor' ? 'processor' : input.requesterRole} submission]`);
    lines.push('');
    lines.push(`Entity: ${input.entityName}`);
    if (input.formType) lines.push(`Form: ${input.formType}`);
    lines.push(`Years: ${years}`);
    lines.push('');
    if (templateBody) {
      lines.push('Standard ' + (client?.name || 'client') + ' instructions:');
      lines.push(templateBody.replace(/\{years\}/g, years));
    } else {
      lines.push(`Pull ROA + Tax Return Transcript for the requested form + years above.`);
    }
    if (input.freeTextNotes && input.freeTextNotes.trim()) {
      lines.push('');
      lines.push('Processor notes:');
      lines.push(input.freeTextNotes.trim());
    }
    const body = lines.join('\n');

    const { error } = await (admin.from('entity_notes' as any) as any).insert({
      entity_id: input.entityId,
      author_id: input.requesterUserId,
      author_role: input.requesterRole,
      author_name: input.requesterName,
      body,
      kind: 'instruction',
    });
    if (error) {
      // Graceful degrade if migrations not applied
      if (/entity_notes|column .* does not exist|PGRST/i.test(error.message || '')) {
        return { posted: false, reason: 'migration_pending' };
      }
      console.warn(`[intake-note-autopost] insert failed for ${input.entityName}: ${error.message}`);
      return { posted: false, reason: error.message };
    }
    return { posted: true };
  } catch (err: any) {
    console.warn('[intake-note-autopost] threw:', err?.message || err);
    return { posted: false, reason: err?.message || String(err) };
  }
}

function formatYears(years: (string | number)[]): string {
  const nums = years.map((y) => parseInt(String(y), 10)).filter(Number.isFinite);
  if (nums.length === 0) return '(TBD)';
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  if (sorted.length === 1) return String(sorted[0]);
  const contiguous = sorted.every((y, i) => i === 0 || y === sorted[i - 1] + 1);
  return contiguous ? `${sorted[0]}-${sorted[sorted.length - 1]}` : sorted.join(', ');
}
