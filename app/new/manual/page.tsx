/**
 * /new/manual — Manual entry workflow (single borrower / multi-entity).
 *
 * Dedicated URL so we can track manual-flow popularity and bug reports
 * separately in Vercel analytics. Renders the shared header + the
 * extracted ManualEntryFlow component.
 */

import { ManualEntryFlow } from '@/components/ManualEntryFlow';
import { NewRequestHeader } from '@/components/NewRequestHeader';

export const metadata = {
  title: 'Manual Entry — New Request',
};

export default function NewManualRequestPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <NewRequestHeader mode="manual" />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <ManualEntryFlow />
      </div>
    </div>
  );
}
