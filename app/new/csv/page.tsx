/**
 * /new/csv — Batch CSV/Excel upload workflow.
 *
 * Dedicated URL so we can track CSV-flow popularity and bug reports
 * separately in Vercel analytics. Renders the shared header + the
 * extracted CsvUploadFlow component.
 */

import { CsvUploadFlow } from '@/components/CsvUploadFlow';
import { NewRequestHeader } from '@/components/NewRequestHeader';

export const metadata = {
  title: 'CSV / Excel Upload — New Request',
};

export default function NewCsvRequestPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <NewRequestHeader mode="csv" />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <CsvUploadFlow />
      </div>
    </div>
  );
}
