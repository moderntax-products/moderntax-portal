import type { RequestStatus } from '@/lib/types';

interface StatusBadgeProps {
  status: RequestStatus | string;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const statusConfig: Record<string, { bg: string; text: string; label: string }> = {
    submitted: {
      bg: 'bg-blue-50',
      text: 'text-blue-700',
      label: 'Submitted',
    },
    '8821_sent': {
      bg: 'bg-yellow-50',
      text: 'text-yellow-700',
      label: 'Form 8821 Sent',
    },
    '8821_signed': {
      bg: 'bg-indigo-50',
      text: 'text-indigo-700',
      label: 'Form 8821 Signed',
    },
    irs_queue: {
      bg: 'bg-amber-50',
      text: 'text-amber-700',
      label: 'IRS Queue',
    },
    processing: {
      bg: 'bg-orange-50',
      text: 'text-orange-700',
      label: 'Processing',
    },
    completed: {
      bg: 'bg-green-50',
      text: 'text-green-700',
      label: 'Completed',
    },
    failed: {
      bg: 'bg-red-50',
      text: 'text-red-700',
      label: 'Failed',
    },
  };

  const config = statusConfig[status] || statusConfig.submitted;

  return (
    <span
      className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${config.bg} ${config.text}`}
    >
      {config.label}
    </span>
  );
}
