'use client';

/**
 * Replace the 8821 attached to an existing entity — the "I uploaded the
 * wrong one" recovery control on the request page.
 *
 * Exists because Carla DeGuzman (Cal Statewide, 2026-07-22) attached an
 * UNSIGNED 8821, watched the order auto-assign to an expert, and had no way
 * to correct it short of emailing Matt. Wrong-attachment must be a two-click
 * fix on the order itself.
 *
 * Upload goes through /api/upload/sign-8821 signed slots (browser → storage
 * directly), NOT through the API route body — scanned 8821s routinely blow
 * past Vercel's ~4.5 MB request cap, which is the 413 that stopped Robin.
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@supabase/supabase-js';

interface Props {
  entityId: string;
  entityName: string;
  /** Whether a signed 8821 is currently attached — flips the copy. */
  hasExisting: boolean;
}

export function ReplaceSigned8821({ entityId, entityName, hasExisting }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      // 1. Get a signed storage slot (server-assigned path in our prefix).
      const signRes = await fetch('/api/upload/sign-8821', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: [{ name: file.name, size: file.size }] }),
      });
      const signData = await signRes.json().catch(() => ({}));
      if (!signRes.ok) { setError(signData.error || 'Could not prepare the upload'); return; }
      const slot = signData.uploads?.[0];
      if (!slot) { setError('Could not prepare the upload'); return; }

      // 2. Browser → storage directly (dodges the serverless body cap).
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      );
      const { error: upErr } = await supabase.storage
        .from('uploads')
        .uploadToSignedUrl(slot.path, slot.token, file, { contentType: 'application/pdf' });
      if (upErr) { setError(`Upload failed: ${upErr.message}`); return; }

      // 3. Attach it to the entity.
      const res = await fetch('/api/entity/replace-8821', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId, storagePath: slot.path }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Could not attach the new 8821'); return; }

      setDone(
        data.expert_notified
          ? 'New 8821 attached. The assigned expert has been notified to use this copy.'
          : 'New 8821 attached.',
      );
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  if (done) {
    return <p className="text-sm text-green-700 mt-2">{done}</p>;
  }

  return (
    <div className="mt-2">
      <input
        ref={fileRef}
        type="file"
        accept=".pdf"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => fileRef.current?.click()}
        className="text-sm font-medium text-mt-green hover:underline disabled:opacity-50"
      >
        {busy
          ? 'Uploading…'
          : hasExisting
            ? 'Wrong file? Replace the 8821'
            : `Upload the signed 8821 for ${entityName}`}
      </button>
      {error && <p className="text-sm text-red-600 mt-1">{error}</p>}
    </div>
  );
}
