/**
 * /new/pdf — Signed 8821 PDF upload workflow.
 *
 * Dedicated URL so we can track PDF-flow popularity and bug reports
 * separately in Vercel analytics. Renders the shared header + the
 * extracted PdfUploadFlow component.
 */

import { PdfUploadFlow } from '@/components/PdfUploadFlow';
import { NewRequestHeader } from '@/components/NewRequestHeader';

export const metadata = {
  title: 'Signed 8821 PDF Upload — New Request',
};

export default function NewPdfRequestPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <NewRequestHeader mode="pdf" />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <PdfUploadFlow />
      </div>
    </div>
  );
}
