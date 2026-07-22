/**
 * Server-to-server calls into the portal. We REUSE the portal's existing
 * Sinch fax bridge rather than re-implementing faxing here — one fax code
 * path, already wired to delivery callbacks.
 */

import { CONFIG } from './config';

export async function sendFaxViaPortal(
  sessionId: string,
  entityId: string,
  faxNumber: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${CONFIG.portalBaseUrl}/api/expert/irs-call/mid-call-fax`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Server-to-server auth; the portal route must accept this secret for
        // internal callers (voice engine) in addition to its expert session.
        'x-voice-engine-secret': CONFIG.portalInternalSecret,
      },
      body: JSON.stringify({ sessionId, entityId, faxNumber }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `portal ${res.status}: ${body.slice(0, 120)}` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
