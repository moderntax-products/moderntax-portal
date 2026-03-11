/**
 * Data masking utilities for SOC 2 compliance
 * PII like Tax IDs (SSN/EIN) must be masked when displayed
 */

/**
 * Mask a Tax ID number, showing only last 4 digits
 * SSN: XXX-XX-1234 → ***-**-1234
 * EIN: XX-XXXXXXX → **-***1234
 * Generic: only last 4 chars shown
 */
export function maskTid(tid: string | null | undefined, kind?: string): string {
  if (!tid) return '—';

  // Strip all non-alphanumeric chars for processing
  const digits = tid.replace(/[^0-9A-Za-z]/g, '');

  if (digits.length < 4) return '****';

  const last4 = digits.slice(-4);

  if (kind === 'SSN') {
    return `***-**-${last4}`;
  }
  if (kind === 'EIN') {
    return `**-***${last4}`;
  }

  // Generic fallback
  return `****${last4}`;
}

/**
 * Classify data sensitivity level
 */
export type DataClassification = 'public' | 'internal' | 'confidential' | 'restricted';

export function getClassificationLabel(level: DataClassification): string {
  switch (level) {
    case 'restricted':
      return 'RESTRICTED — Contains PII / Tax Data';
    case 'confidential':
      return 'CONFIDENTIAL — Internal Business Data';
    case 'internal':
      return 'INTERNAL — For Authorized Users Only';
    case 'public':
      return 'PUBLIC';
  }
}

export function getClassificationColor(level: DataClassification): string {
  switch (level) {
    case 'restricted':
      return 'bg-red-100 text-red-800 border-red-300';
    case 'confidential':
      return 'bg-orange-100 text-orange-800 border-orange-300';
    case 'internal':
      return 'bg-yellow-100 text-yellow-800 border-yellow-300';
    case 'public':
      return 'bg-green-100 text-green-800 border-green-300';
  }
}
