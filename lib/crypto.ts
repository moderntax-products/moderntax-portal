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
 * Format DOB for natural speech: "August twenty-fourth, nineteen eighty-seven"
 * This is the format IRS agents are most used to hearing and is unambiguous.
 */
export function formatDOBForSpeech(isoDob: string): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const ordinals = [
    '', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
    'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
    'eighteenth', 'nineteenth', 'twentieth', 'twenty-first', 'twenty-second', 'twenty-third',
    'twenty-fourth', 'twenty-fifth', 'twenty-sixth', 'twenty-seventh', 'twenty-eighth',
    'twenty-ninth', 'thirtieth', 'thirty-first',
  ];
  const yearWords = (y: number) => {
    if (y < 2000) {
      const mid = Math.floor((y - 1900) / 10);
      const ones = (y - 1900) % 10;
      const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'][mid] || '';
      const ward = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][ones];
      const teensMap: Record<number, string> = {
        10: 'ten', 11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen',
        16: 'sixteen', 17: 'seventeen', 18: 'eighteen', 19: 'nineteen',
      };
      const last2 = y - 1900;
      const last2Words = last2 in teensMap ? teensMap[last2] : `${tens}${ones ? '-' + ward : ''}`;
      return `nineteen ${last2Words}`;
    }
    // 2000+ — "two thousand twenty-three"
    const yMod = y - 2000;
    if (yMod === 0) return 'two thousand';
    const tensMap: Record<number, string> = { 2: 'twenty', 3: 'thirty', 4: 'forty' };
    const ones = yMod % 10;
    const tensDigit = Math.floor(yMod / 10);
    const teensMap: Record<number, string> = {
      10: 'ten', 11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen',
      16: 'sixteen', 17: 'seventeen', 18: 'eighteen', 19: 'nineteen',
    };
    if (yMod < 10) return `two thousand ${['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][ones]}`;
    if (yMod in teensMap) return `two thousand ${teensMap[yMod]}`;
    const onesWord = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'][ones];
    return `two thousand ${tensMap[tensDigit]}${ones ? '-' + onesWord : ''}`;
  };

  const [y, mo, d] = isoDob.split('-').map(Number);
  return `${months[mo - 1]} ${ordinals[d]}, ${yearWords(y)}`;
}

/**
 * Digit-by-digit speech with pauses after groups of 3 or at hyphens.
 * Used for EINs, CAF numbers, phone numbers.
 */
export function formatDigitsForSpeech(input: string): string {
  const digits = (input || '').replace(/\D/g, '');
  if (digits.length === 0) return '';
  const chunks: string[] = [];
  // Natural grouping: 3-3-3 for 9-digit, 3-4 for 7-digit, etc.
  if (digits.length === 9) {
    chunks.push(digits.slice(0, 3), digits.slice(3, 6), digits.slice(6));
  } else if (digits.length === 10) {
    chunks.push(digits.slice(0, 3), digits.slice(3, 6), digits.slice(6));
  } else {
    // 3-digit groups generally
    for (let i = 0; i < digits.length; i += 3) chunks.push(digits.slice(i, i + 3));
  }
  return chunks.map(c => c.split('').join(' ')).join(', ');
}

/**
 * Speech form of CAF number — e.g. "1234-56789R" → "one two three four,
 * five six seven eight nine, Romeo". Handles the trailing letter separately
 * so the AI says the NATO phonetic for it.
 */
export function formatCafForSpeech(caf: string): string {
  const cleaned = (caf || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!cleaned) return '';
  const letterMatch = cleaned.match(/^([0-9]+)([A-Z])$/);
  const digits = letterMatch ? letterMatch[1] : cleaned.replace(/[A-Z]/g, '');
  const letter = letterMatch ? letterMatch[2] : '';
  const nato: Record<string, string> = {
    A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot',
    G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliet', K: 'Kilo', L: 'Lima',
    M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo',
    S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray',
    Y: 'Yankee', Z: 'Zulu',
  };
  const digitWords = digits.split('').map(d => ({
    '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
  }[d] || d));
  // Group digits into 4-4 for a 10-char CAF + letter
  const groups: string[] = [];
  for (let i = 0; i < digitWords.length; i += 4) {
    groups.push(digitWords.slice(i, i + 4).join(' '));
  }
  return letter ? `${groups.join(', ')}, ${nato[letter]}` : groups.join(', ');
}

/**
 * Render any string character-by-character in NATO phonetic. Letters become
 * their NATO word, digits become their English number word, hyphens become
 * "dash". E.g. "MCA-R-31" → "Mike, Charlie, Alpha, dash, Romeo, dash,
 * three, one".
 */
export function formatNATOSpelling(s: string): string {
  const nato: Record<string, string> = {
    A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot',
    G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliet', K: 'Kilo', L: 'Lima',
    M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo',
    S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray',
    Y: 'Yankee', Z: 'Zulu',
  };
  const digits: Record<string, string> = {
    '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
    '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
  };
  return s.toUpperCase().split('').map(ch => {
    if (nato[ch]) return nato[ch];
    if (digits[ch]) return digits[ch];
    if (ch === '-' || ch === '_') return 'dash';
    if (ch === '.') return 'dot';
    return '';
  }).filter(Boolean).join(', ');
}

/**
 * Spelled-out form names so TTS doesn't read them as cardinal numbers.
 *
 * Bug history:
 *   • Pass 1: returned "eleven-twenty-S" with hyphens — TTS spoke the
 *     dashes as "eleven dash twenty dash S".
 *   • Pass 2: returned raw "1120-S" hoping TTS would handle it — TTS
 *     read "8821" as "eight thousand eight hundred twenty-one"
 *     (Matt 4/25 PSTN test).
 *   • Pass 3 (this version): explicit spelled-out form names with
 *     spaces, matching how actual tax practitioners say them on PPS
 *     calls. Hyphens only inside compound numbers like "twenty-one".
 */
export function formatFormForSpeech(form: string): string {
  const s = (form || '').trim().toUpperCase();
  const map: Record<string, string> = {
    '1040':   'ten forty',
    '1040X':  'ten forty X',
    '1040EZ': 'ten forty E Z',
    '1065':   'ten sixty-five',
    '1120':   'eleven twenty',
    '1120S':  'eleven twenty S',
    '1120X':  'eleven twenty X',
    '1099':   'ten ninety-nine',
    '940':    'nine forty',
    '941':    'nine forty-one',
    '944':    'nine forty-four',
    '2848':   'twenty-eight forty-eight',
    '8821':   'eighty-eight twenty-one',
    '8879':   'eighty-eight seventy-nine',
    '4506':   'forty-five oh-six',
    '4506T':  'forty-five oh-six T',
    'W2':     'W two',
    'W-2':    'W two',
    'W3':     'W three',
    'W-3':    'W three',
  };
  return map[s] || s;
}

/**
 * Years stay as raw 4-digit strings — modern TTS speaks "2022" as
 * "twenty twenty-two" naturally. Pre-spelling (e.g. forcing
 * "twenty twenty-two") created weird hyphenation artifacts in the
 * 4/25 PSTN test ("agent not using natural human language").
 */
export function formatYearForSpeech(year: string): string {
  return (year || '').trim();
}

/**
 * Join years into a natural English list: "2022, 2023, and 2024".
 * TTS speaks each year naturally on its own.
 */
export function formatYearsForSpeech(years: string[]): string {
  const cleaned = (years || []).map(y => (y || '').trim()).filter(Boolean);
  if (cleaned.length === 0) return '';
  if (cleaned.length === 1) return cleaned[0];
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return `${cleaned.slice(0, -1).join(', ')}, and ${cleaned[cleaned.length - 1]}`;
}

/**
 * Ordinal in English for list position (1-indexed). Used when the AI
 * introduces each client: "For my first client...", "For my second client...".
 */
export function ordinalWord(n: number): string {
  const words = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
  return words[n] || `${n}th`;
}
