'use client';

/**
 * Action hub at the top of a processor's request view. Turns the page from a
 * static receipt into a working surface: place another order, reorder from
 * history, add monitoring, and share this request with the team.
 *
 * Sharing model (SOC 2): the request itself contains IRS PII, so we never mint
 * a long-lived no-login link to it. Teammates on the same account open the
 * normal request URL (they log in); processors/managers can invite another
 * processor to their own organization (same-client, processor-only — no role
 * escalation). For pushing a single document into an outside SBA/LOS system,
 * the per-file "Copy link" gives a secure 1-hour signed URL instead.
 *
 * Built 2026-07-31 from Sonja (Cal Statewide) + Elena (BFC Funding) feedback:
 * both want to grow their own team and move documents into their loan file
 * without waiting on us. Processors can invite processors + share internally.
 */

import { useState } from 'react';
import Link from 'next/link';
import { InviteUserForm } from './InviteUserForm';

interface Props {
  requestId: string;
  canInvite: boolean;
  showMonitoring: boolean;
  inviteClient: { id: string; name: string } | null; // manager's/processor's own org
}

const PRIMARY = 'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold bg-mt-green text-white hover:bg-opacity-90 transition-colors';
const OUTLINE = 'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-semibold border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors';

export function ProcessorActionBar({ requestId, canInvite, showMonitoring, inviteClient }: Props) {
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const scrollToMonitoring = () => {
    document.getElementById('monitoring')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const copyRequestLink = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/request/${requestId}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard blocked — non-fatal */
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 mb-8">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mr-1">Actions</span>
        <Link href="/new" className={PRIMARY}>+ New order</Link>
        <Link href="/new/reorder" className={OUTLINE}>⟳ Reorder</Link>
        {showMonitoring && (
          <button type="button" onClick={scrollToMonitoring} className={OUTLINE}>👁 Add monitoring</button>
        )}
        <button
          type="button"
          onClick={() => setShareOpen((v) => !v)}
          className={OUTLINE}
          aria-expanded={shareOpen}
        >
          🔗 Share {shareOpen ? '▲' : '▾'}
        </button>
      </div>

      {shareOpen && (
        <div className="mt-4 border-t border-gray-100 pt-4 space-y-5">
          {/* Share the request internally */}
          <div>
            <p className="text-sm font-semibold text-gray-800">Share this request with your team</p>
            <p className="text-xs text-gray-500 mt-0.5 max-w-2xl">
              Anyone on your organization&apos;s account can open this link (they&apos;ll sign in to view it). To
              drop a document into your loan file or an outside system, use <span className="font-medium">Copy link</span> on
              each file below — that gives a secure link that expires in an hour.
            </p>
            <div className="mt-2">
              <button
                type="button"
                onClick={copyRequestLink}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-semibold border transition-colors ${
                  copied ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                {copied ? '✓ Link copied' : 'Copy request link'}
              </button>
            </div>
          </div>

          {/* Invite a teammate */}
          {canInvite && inviteClient ? (
            <div className="border-t border-gray-100 pt-4">
              <p className="text-sm font-semibold text-gray-800 mb-1">Invite a teammate</p>
              <p className="text-xs text-gray-500 mb-3 max-w-2xl">
                Add a processor to <span className="font-medium">{inviteClient.name}</span>. They get their own
                login and can place and view orders for your organization.
              </p>
              <InviteUserForm managerMode clients={[inviteClient]} />
            </div>
          ) : (
            <div className="border-t border-gray-100 pt-4">
              <p className="text-xs text-gray-500">
                Need to add a teammate? Email{' '}
                <a href="mailto:support@moderntax.io" className="text-mt-green hover:underline">support@moderntax.io</a>.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
