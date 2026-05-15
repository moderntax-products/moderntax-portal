/**
 * Legacy redirect — preserved because external 402 paywall responses
 * historically sent partners here. The real self-serve enrollment lives
 * on the Invoicing page (Payment Settings card → Enroll Mercury button).
 */

import { redirect } from 'next/navigation';

export default function ConnectMercuryPage() {
  redirect('/invoicing#payment-settings');
}
