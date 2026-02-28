import { CheckCircle2, Circle } from 'lucide-react';
import type { RequestStatus } from '@/lib/types';

interface RequestTimelineProps {
  currentStatus: RequestStatus;
  timestamps?: Record<string, string>;
}

export function RequestTimeline({ currentStatus, timestamps = {} }: RequestTimelineProps) {
  const steps: { status: RequestStatus; label: string }[] = [
    { status: 'submitted', label: 'Submitted' },
    { status: '8821_sent', label: 'Form 8821 Sent' },
    { status: '8821_signed', label: 'Form 8821 Signed' },
    { status: 'irs_queue', label: 'IRS Queue' },
    { status: 'processing', label: 'Processing' },
    { status: 'completed', label: 'Complete' },
  ];

  const statusOrder: Record<RequestStatus, number> = {
    submitted: 0,
    '8821_sent': 1,
    '8821_signed': 2,
    irs_queue: 3,
    processing: 4,
    completed: 5,
    failed: 5,
  };

  const currentIndex = statusOrder[currentStatus] || 0;
  const isFailed = currentStatus === 'failed';

  return (
    <div className="bg-white rounded-lg shadow-md p-8">
      <h3 className="text-lg font-semibold text-gray-900 mb-8">Request Timeline</h3>

      <div className="relative">
        {/* Timeline line */}
        <div className="absolute left-6 top-0 bottom-0 w-1 bg-gray-200" />

        {/* Steps */}
        <div className="space-y-8">
          {steps.map((step, index) => {
            const isCompleted = index < currentIndex;
            const isCurrent = index === currentIndex && !isFailed;
            const isFutureOrFailed = index > currentIndex || isFailed;

            return (
              <div key={step.status} className="relative pl-16">
                {/* Circle indicator */}
                <div className="absolute left-0">
                  {isCompleted ? (
                    <div className="flex items-center justify-center w-12 h-12 rounded-full bg-emerald-500 text-white shadow-lg">
                      <CheckCircle2 className="w-6 h-6" />
                    </div>
                  ) : isCurrent ? (
                    <div className="flex items-center justify-center w-12 h-12 rounded-full bg-amber-500 text-white shadow-lg animate-pulse">
                      <Circle className="w-6 h-6" />
                    </div>
                  ) : (
                    <div
                      className={`flex items-center justify-center w-12 h-12 rounded-full border-2 ${
                        isFailed ? 'border-red-300 bg-red-50' : 'border-gray-300 bg-gray-50'
                      }`}
                    >
                      <Circle className={`w-6 h-6 ${isFailed ? 'text-red-300' : 'text-gray-300'}`} />
                    </div>
                  )}
                </div>

                {/* Content */}
                <div>
                  <p
                    className={`font-semibold ${
                      isCompleted || isCurrent
                        ? 'text-gray-900'
                        : isFailed
                          ? 'text-red-500'
                          : 'text-gray-500'
                    }`}
                  >
                    {step.label}
                  </p>
                  {timestamps[step.status] && (
                    <p className="text-sm text-gray-500 mt-1">
                      {new Date(timestamps[step.status]).toLocaleDateString()} at{' '}
                      {new Date(timestamps[step.status]).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Failed status message */}
        {isFailed && (
          <div className="mt-8 p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-red-800 text-sm font-medium">
              This request failed processing. Please contact support for assistance.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
