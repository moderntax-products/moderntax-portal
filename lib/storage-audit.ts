/**
 * Storage traversal helpers — audit + lifecycle cleanup of the `uploads` bucket.
 *
 * The 2026-07-17 Supabase quota trip (1.48 GB over the 1.1 GB Free cap) was
 * caused by throwaway files accumulating with no lifecycle. Even on Pro (100 GB)
 * we prune them so it never recurs and storage cost stays flat.
 *
 * Supabase's storage `.list()` is non-recursive and returns FILES (which carry
 * an `id` + `metadata.size`) alongside FOLDERS (id === null). We walk it
 * ourselves, with a hard scan cap so a huge bucket can't hang a request.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const UPLOADS_BUCKET = 'uploads';
const PAGE = 1000;

export interface StoredFile {
  path: string;
  size: number;
  created_at: string;
}

/** Immediate children (files + folders) of a prefix, paginated. */
async function listChildren(admin: SupabaseClient, prefix: string): Promise<any[]> {
  const out: any[] = [];
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await admin.storage.from(UPLOADS_BUCKET)
      .list(prefix, { limit: PAGE, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw new Error(error.message);
    const items = data || [];
    out.push(...items);
    if (items.length < PAGE) break;
    offset += PAGE;
  }
  return out;
}

/** Recursively collect files under a prefix (BFS), stopping at `cap` files. */
export async function collectFiles(
  admin: SupabaseClient,
  prefix: string,
  cap = 20000,
): Promise<{ files: StoredFile[]; capped: boolean }> {
  const files: StoredFile[] = [];
  const queue: string[] = [prefix];
  while (queue.length) {
    const p = queue.shift() as string;
    const items = await listChildren(admin, p);
    for (const it of items) {
      const full = p ? `${p}/${it.name}` : it.name;
      if (it.id) {
        files.push({ path: full, size: Number(it.metadata?.size || 0), created_at: it.created_at || it.updated_at || '' });
        if (files.length >= cap) return { files, capped: true };
      } else if (it.name) {
        queue.push(full); // folder → recurse
      }
    }
  }
  return { files, capped: false };
}

/** Top-level (first path segment) size + count breakdown of the whole bucket. */
export async function auditByTopPrefix(
  admin: SupabaseClient,
  cap = 20000,
): Promise<{ prefixes: Array<{ prefix: string; files: number; bytes: number }>; total_files: number; total_bytes: number; capped: boolean }> {
  const roots = await listChildren(admin, '');
  const rows: Array<{ prefix: string; files: number; bytes: number }> = [];
  let total_files = 0, total_bytes = 0, capped = false;
  let remaining = cap;

  for (const r of roots) {
    if (remaining <= 0) { capped = true; break; }
    if (r.id) {
      // A file at the bucket root.
      const sz = Number(r.metadata?.size || 0);
      rows.push({ prefix: r.name, files: 1, bytes: sz });
      total_files += 1; total_bytes += sz; remaining -= 1;
      continue;
    }
    const { files, capped: c } = await collectFiles(admin, r.name, remaining);
    const bytes = files.reduce((s, f) => s + f.size, 0);
    rows.push({ prefix: `${r.name}/`, files: files.length, bytes });
    total_files += files.length; total_bytes += bytes; remaining -= files.length;
    if (c) { capped = true; break; }
  }

  rows.sort((a, b) => b.bytes - a.bytes);
  return { prefixes: rows, total_files, total_bytes, capped };
}

export const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
};
