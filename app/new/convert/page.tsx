/**
 * /new/convert — Re-designate a signed 8821 from another vendor.
 *
 * Driver: Enterprise Bank's first trial 2026-05-20. Derek had a signed
 * Tax Guard 8821 for K.O.K. Trucking and just needed a fresh ModernTax-
 * designated version to send for re-signature. Pattern repeats with
 * Cal Statewide, Centerstone, and any other lender swapping vendors.
 */

import { ConvertVendor8821Flow } from '@/components/ConvertVendor8821Flow';
import { NewRequestHeader } from '@/components/NewRequestHeader';

export const metadata = {
  title: 'Convert Vendor 8821 — New Request',
  description: 'Upload a signed 8821 from another vendor (Tax Guard, Wolters Kluwer, etc.) and download a fresh ModernTax-designated 8821 for re-signature.',
};

export default function ConvertVendor8821Page() {
  return (
    <div className="min-h-screen bg-gray-50">
      <NewRequestHeader mode="convert" />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <ConvertVendor8821Flow />
      </div>
    </div>
  );
}
