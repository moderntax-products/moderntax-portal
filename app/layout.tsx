import type { Metadata } from 'next';
import './globals.css';

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
      <body>{children}</body>
    </html>
  );
}
