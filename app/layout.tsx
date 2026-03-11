import type { Metadata } from 'next';
import './globals.css';
import { SessionTimeout } from '@/components/SessionTimeout';
import { Analytics } from '@/components/Analytics';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'ModernTax Portal - IRS Transcript Verification',
  description:
    'Real-time IRS transcript verification portal for lending partners. Submit, track, and download transcripts securely.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        {children}
        <SessionTimeout />
        <Analytics />
      </body>
    </html>
  );
}
