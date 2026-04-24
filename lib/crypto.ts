/**
 * Expert credentials encryption — AES-256-GCM.
 *
 * Used for SSN + DOB of IRS practitioners. IRS PPS requires the practitioner
 * to verbally confirm their own SSN + DOB before the agent will release
 * transcripts to the practitioner's SOR inbox. We store these encrypted at
 * rest, decrypt only at call-initiation time, and pass to Retell as
 * dynamic variables (in-memory only, not persisted on Retell's side).
 *
 * Key management:
 *   • EXPERT_CREDENTIALS_KEY is a 32-byte key, base64-encoded, in env.
 *   • Store in Vercel env (Production), .env.local (dev). Never commit.
 *   • Rotation: decrypt with old key, re-encrypt with new key, bump env.
 *     Helper scripts can be added to scripts/ when rotation is needed.
 *
 * Format on disk: base64 of (IV || GCM tag || ciphertext).
 *   IV:        12 bytes
 *   GCM tag:   16 bytes
 *   ciphertext: variable
 *
 * SOC 2: credential access is audit-logged via lib/audit in the endpoint
 * that calls decrypt*(), not here.
 */

import * as crypto from 'crypto';

const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  const raw = process.env.EXPERT_CREDENTIALS_KEY;
  if (!raw) throw new Error('EXPERT_CREDENTIALS_KEY not configured');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(`EXPERT_CREDENTIALS_KEY must decode to 32 bytes (AES-256); got ${buf.length}`);
  }
  return buf;
}

/**
 * Encrypt a plaintext string. Output is base64-encoded bytes safe to store
 * in a Postgres text column.
 */
export function encryptCredential(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Decrypt a previously-encrypted credential. Throws on tamper (GCM auth
 * tag mismatch) — caller should treat any throw as "do not use".
 */
export function decryptCredential(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Ciphertext too short to be valid');
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Normalize SSN: strip all non-digits, reject if not exactly 9 digits.
 * Returns the sanitized 9-digit string.
 */
export function normalizeSSN(input: string): string {
  const digits = (input || '').replace(/\D/g, '');
  if (digits.length !== 9) throw new Error('SSN must be 9 digits');
  return digits;
}

/**
 * Normalize DOB: accepts MM/DD/YYYY, MM-DD-YYYY, YYYY-MM-DD. Returns as
 * ISO YYYY-MM-DD. Validates that the date is real and not in the future.
 */
export function normalizeDOB(input: string): string {
  const s = (input || '').trim();
  let m: RegExpMatchArray | null;
  let year: string, month: string, day: string;

  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) { year = m[1]; month = m[2]; day = m[3]; }
  else {
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (m) { month = m[1]; day = m[2]; year = m[3]; }
    else throw new Error('DOB must be MM/DD/YYYY, MM-DD-YYYY, or YYYY-MM-DD');
  }

  const mo = parseInt(month, 10);
  const d  = parseInt(day, 10);
  const y  = parseInt(year, 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > new Date().getFullYear()) {
    throw new Error('DOB out of range');
  }
  const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const parsed = new Date(iso + 'T00:00:00Z');
  if (isNaN(parsed.getTime()) || parsed > new Date()) throw new Error('DOB invalid or in the future');
  return iso;
}

/**
 * For speaking an SSN over the phone, we want digit-by-digit spelling with
 * pauses — e.g. "5-9-0, 5-8, 0-6-6-5" with a brief pause at each dash.
 * Returns a string the AI should read aloud.
 */
export function formatSSNForSpeech(ssn: string): string {
  const d = ssn.replace(/\D/g, '');
  if (d.length !== 9) return d.split('').join(' ');
  return `${d[0]} ${d[1]} ${d[2]}, ${d[3]} ${d[4]}, ${d[5]} ${d[6]} ${d[7]} ${d[8]}`;
}

/**
 * Format DOB for speech: "August twenty-fourth, nineteen eighty-seven" OR
 * "eight, twenty-four, nineteen eighty-seven" (MM DD YYYY). We prefer the
 * numeric MM DD YYYY form since that's exactly how IRS agents expect to
 * hear DOBs — less ambiguous than month names.
 */
export function formatDOBForSpeech(isoDob: string): string {
  const [y, mo, d] = isoDob.split('-').map(Number);
  return `${mo} ${d} ${y}`;
}
