'use client';

import { useState } from 'react';

interface Entity8821InfoProps {
  entity: {
    entity_name: string;
    tid: string;
    tid_kind: string;
    address: string | null;
    city: string | null;
    state: string | null;
    zip_code: string | null;
    form_type: string;
    years: string[];
    signer_first_name: string | null;
    signer_last_name: string | null;
  };
}

/**
 * Admin component showing entity info in 8821 form format.
 * Allows copying all info to clipboard for pasting into an 8821 form.
 * Shows unmasked TID with show/hide toggle.
 */
export function Entity8821Info({ entity }: Entity8821InfoProps) {
  const [copied, setCopied] = useState(false);
  const [showTid, setShowTid] = useState(false);

  // Format TID with proper dashes
  const formatTid = (tid: string, kind: string) => {
    const digits = tid.replace(/\D/g, '');
    if (kind === 'SSN' && digits.length === 9) {
      return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
    }
    if (kind === 'EIN' && digits.length === 9) {
      return `${digits.slice(0, 2)}-${digits.slice(2)}`;
    }
    return tid;
  };

  // Mask TID showing only last 4
  const maskTid = (tid: string, kind: string) => {
    const digits = tid.replace(/\D/g, '');
    if (digits.length < 4) return '****';
    const last4 = digits.slice(-4);
    if (kind === 'SSN') return `***-**-${last4}`;
    if (kind === 'EIN') return `**-***${last4}`;
    return `****${last4}`;
  };

  // Map form type to tax type for Section 3(a)
  const getTaxType = (formType: string) => {
    if (formType.startsWith('1040') || formType.startsWith('1065') || formType.startsWith('1120')) {
      return 'Income';
    }
    if (formType.startsWith('941') || formType.startsWith('940')) {
      return 'Employment';
    }
    return 'Income';
  };

  // Build copy text matching 8821 sections
  const buildCopyText = () => {
    const lines = [];
    lines.push('=== SECTION 1: TAXPAYER INFO ===');
    lines.push(`Taxpayer Name: ${entity.entity_name}`);
    lines.push(`${entity.tid_kind}: ${formatTid(entity.tid, entity.tid_kind)}`);
    if (entity.address) {
      lines.push(`Address: ${entity.address}`);
      lines.push(`City/State/Zip: ${entity.city || ''}, ${entity.state || ''} ${entity.zip_code || ''}`);
    }
    if (entity.signer_first_name) {
      lines.push(`Signer: ${entity.signer_first_name} ${entity.signer_last_name || ''}`);
    }
    lines.push('');
    lines.push('=== SECTION 3: TAX INFO ===');
    lines.push(`(a) Type of Tax: ${getTaxType(entity.form_type)}`);
    lines.push(`(b) Tax Form: ${entity.form_type}`);
    lines.push(`(c) Years: ${entity.years.join(', ')}`);
    lines.push(`(d) Specific Tax Matters: Account Transcript, Record of Account, Wage & Income`);
    return lines.join('\n');
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildCopyText());
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const textarea = document.createElement('textarea');
      textarea.value = buildCopyText();
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-4 text-sm space-y-3">
      <div className="flex items-center justify-between">
        <h5 className="font-semibold text-indigo-900 text-xs uppercase tracking-wide">
          8821 Form Info
        </h5>
        <button
          onClick={handleCopy}
          className="px-2.5 py-1 text-xs font-medium bg-indigo-600 text-white rounded hover:bg-indigo-700 transition-colors"
        >
          {copied ? '✓ Copied' : 'Copy All'}
        </button>
      </div>

      {/* Section 1: Taxpayer Info */}
      <div className="space-y-1">
        <p className="text-[10px] font-semibold text-indigo-600 uppercase tracking-wider">
          Section 1 — Taxpayer
        </p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <div>
            <span className="text-gray-500">Name:</span>
            <span className="ml-1 font-medium text-gray-900">{entity.entity_name}</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-gray-500">{entity.tid_kind}:</span>
            <span className="ml-1 font-mono font-medium text-gray-900">
              {showTid ? formatTid(entity.tid, entity.tid_kind) : maskTid(entity.tid, entity.tid_kind)}
            </span>
            <button
              onClick={() => setShowTid(!showTid)}
              className="text-indigo-500 hover:text-indigo-700 underline text-[10px] ml-1"
            >
              {showTid ? 'hide' : 'show'}
            </button>
          </div>
          {entity.address && (
            <div className="col-span-2">
              <span className="text-gray-500">Address:</span>
              <span className="ml-1 text-gray-900">
                {entity.address}, {entity.city}, {entity.state} {entity.zip_code}
              </span>
            </div>
          )}
          {entity.signer_first_name && (
            <div className="col-span-2">
              <span className="text-gray-500">Signer:</span>
              <span className="ml-1 text-gray-900">
                {entity.signer_first_name} {entity.signer_last_name || ''}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Section 3: Tax Info */}
      <div className="space-y-1">
        <p className="text-[10px] font-semibold text-indigo-600 uppercase tracking-wider">
          Section 3 — Tax Information
        </p>
        <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-xs">
          <div>
            <span className="text-gray-500">(a) Type:</span>
            <span className="ml-1 font-medium text-gray-900">{getTaxType(entity.form_type)}</span>
          </div>
          <div>
            <span className="text-gray-500">(b) Form:</span>
            <span className="ml-1 font-medium text-gray-900">{entity.form_type}</span>
          </div>
          <div>
            <span className="text-gray-500">(c) Years:</span>
            <span className="ml-1 font-medium text-gray-900">{entity.years.join(', ')}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
