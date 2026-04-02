'use client';

import { useState, useEffect, useCallback } from 'react';

interface MonitoringSubscription {
  id: string;
  entity_id: string;
  frequency: string;
  custom_interval_days: number | null;
  next_pull_date: string;
  last_pull_date: string | null;
  enrolled_at: string;
  expires_at: string | null;
  status: string;
  enrollment_fee: number;
  per_pull_fee: number;
  total_pulls_completed: number;
  total_billed: number;
  pull_history: { date: string; status: string; transcript_count: number }[];
  latest_summary: string | null;
  latest_summary_at: string | null;
}

interface Entity {
  id: string;
  entity_name: string;
  status: string;
  form_type: string;
  signed_8821_url: string | null;
}

interface MonitoringPanelProps {
  requestId: string;
  entities: Entity[];
}

const FREQUENCY_OPTIONS = [
  { value: 'weekly', label: 'Weekly', description: 'Every 7 days' },
  { value: 'monthly', label: 'Monthly', description: 'Every 30 days' },
  { value: 'quarterly', label: 'Quarterly', description: 'Every 90 days' },
  { value: 'custom', label: 'Custom', description: 'Set your own interval' },
];

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  custom: 'Custom',
};

export function MonitoringPanel({ requestId, entities }: MonitoringPanelProps) {
  const [subscriptions, setSubscriptions] = useState<Record<string, MonitoringSubscription>>({});
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedEntity, setExpandedEntity] = useState<string | null>(null);

  // Enrollment form state
  const [frequency, setFrequency] = useState('monthly');
  const [customDays, setCustomDays] = useState(30);
  const [nextPullDate, setNextPullDate] = useState('');
  const [expiresAt, setExpiresAt] = useState('');

  const fetchSubscriptions = useCallback(async () => {
    try {
      const res = await fetch(`/api/monitoring?requestId=${requestId}`);
      const data = await res.json();
      if (res.ok) {
        const map: Record<string, MonitoringSubscription> = {};
        (data.subscriptions || []).forEach((s: MonitoringSubscription) => {
          map[s.entity_id] = s;
        });
        setSubscriptions(map);
      }
    } catch (err) {
      console.error('Failed to fetch monitoring subscriptions:', err);
    } finally {
      setLoading(false);
    }
  }, [requestId]);

  useEffect(() => {
    fetchSubscriptions();
  }, [fetchSubscriptions]);

  const handleEnroll = async (entityId: string) => {
    setEnrolling(entityId);
    setError(null);

    try {
      const res = await fetch('/api/monitoring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityId,
          requestId,
          frequency,
          customIntervalDays: frequency === 'custom' ? customDays : undefined,
          nextPullDate: nextPullDate || undefined,
          expiresAt: expiresAt || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to enroll');
        return;
      }

      await fetchSubscriptions();
      setExpandedEntity(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enroll');
    } finally {
      setEnrolling(null);
    }
  };

  const handleAction = async (subscriptionId: string, entityId: string, action: string) => {
    setUpdating(entityId);
    setError(null);

    try {
      const res = await fetch('/api/monitoring', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriptionId, action }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Action failed');
        return;
      }

      await fetchSubscriptions();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setUpdating(null);
    }
  };

  const handleUpdateSchedule = async (sub: MonitoringSubscription) => {
    setUpdating(sub.entity_id);
    setError(null);

    try {
      const res = await fetch('/api/monitoring', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscriptionId: sub.id,
          action: 'update',
          frequency,
          customIntervalDays: frequency === 'custom' ? customDays : undefined,
          nextPullDate: nextPullDate || undefined,
          expiresAt: expiresAt || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Update failed');
        return;
      }

      await fetchSubscriptions();
      setExpandedEntity(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setUpdating(null);
    }
  };

  const eligibleEntities = entities.filter(
    (e) => e.signed_8821_url && ['completed', 'irs_queue', 'processing', '8821_signed'].includes(e.status)
  );

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-6 bg-gray-200 rounded w-48" />
          <div className="h-4 bg-gray-100 rounded w-full" />
        </div>
      </div>
    );
  }

  const activeCount = Object.values(subscriptions).filter(s => s.status === 'active').length;

  return (
    <div className="bg-white rounded-lg shadow p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-mt-dark flex items-center gap-2">
            <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            Transcript Monitoring
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Auto-pull updated transcripts on a schedule. Includes up to 10 years of data, AI-summarized changes, and success guarantee.
          </p>
        </div>
        {activeCount > 0 && (
          <span className="px-3 py-1 bg-blue-100 text-blue-800 text-sm font-medium rounded-full">
            {activeCount} Active
          </span>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Pricing banner */}
      <div className="mb-6 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-4">
        <div className="flex items-center gap-6">
          <div className="text-center">
            <p className="text-2xl font-bold text-blue-700">$19.99</p>
            <p className="text-xs text-blue-600">enrollment</p>
          </div>
          <div className="text-gray-400">+</div>
          <div className="text-center">
            <p className="text-2xl font-bold text-blue-700">$39.99</p>
            <p className="text-xs text-blue-600">per update</p>
          </div>
          <div className="flex-1 text-right text-xs text-gray-500 space-y-1">
            <p>Up to 10 years of transcript data</p>
            <p>AI-summarized change detection</p>
            <p>Success guarantee on every pull</p>
          </div>
        </div>
      </div>

      {/* Entity list */}
      <div className="space-y-3">
        {eligibleEntities.length === 0 ? (
          <div className="text-center py-8 text-gray-500">
            <p className="text-sm">No entities eligible for monitoring yet.</p>
            <p className="text-xs mt-1">Entities need a signed 8821 and at least one completed pull to enroll.</p>
          </div>
        ) : (
          eligibleEntities.map((entity) => {
            const sub = subscriptions[entity.id];
            const isExpanded = expandedEntity === entity.id;
            const isProcessing = enrolling === entity.id || updating === entity.id;

            return (
              <div key={entity.id} className="border border-gray-200 rounded-lg overflow-hidden">
                {/* Entity row */}
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-4">
                    <div>
                      <p className="font-medium text-gray-900">{entity.entity_name}</p>
                      <p className="text-xs text-gray-500">{entity.form_type}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    {sub ? (
                      <>
                        {/* Status badge */}
                        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                          sub.status === 'active' ? 'bg-green-100 text-green-800' :
                          sub.status === 'paused' ? 'bg-yellow-100 text-yellow-800' :
                          'bg-gray-100 text-gray-600'
                        }`}>
                          {sub.status === 'active' ? `${FREQUENCY_LABELS[sub.frequency]} Monitoring` : sub.status.charAt(0).toUpperCase() + sub.status.slice(1)}
                        </span>

                        {/* Quick info */}
                        {sub.status === 'active' && (
                          <span className="text-xs text-gray-500">
                            Next: {new Date(sub.next_pull_date).toLocaleDateString()}
                          </span>
                        )}

                        {/* Action buttons */}
                        {sub.status === 'active' && (
                          <div className="flex gap-1">
                            <button
                              onClick={() => setExpandedEntity(isExpanded ? null : entity.id)}
                              disabled={isProcessing}
                              className="px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded hover:bg-blue-100 disabled:opacity-50"
                            >
                              Settings
                            </button>
                            <button
                              onClick={() => handleAction(sub.id, entity.id, 'pause')}
                              disabled={isProcessing}
                              className="px-2 py-1 text-xs font-medium text-yellow-700 bg-yellow-50 rounded hover:bg-yellow-100 disabled:opacity-50"
                            >
                              Pause
                            </button>
                            <button
                              onClick={() => handleAction(sub.id, entity.id, 'cancel')}
                              disabled={isProcessing}
                              className="px-2 py-1 text-xs font-medium text-red-700 bg-red-50 rounded hover:bg-red-100 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </div>
                        )}

                        {sub.status === 'paused' && (
                          <div className="flex gap-1">
                            <button
                              onClick={() => handleAction(sub.id, entity.id, 'resume')}
                              disabled={isProcessing}
                              className="px-2 py-1 text-xs font-medium text-green-700 bg-green-50 rounded hover:bg-green-100 disabled:opacity-50"
                            >
                              Resume
                            </button>
                            <button
                              onClick={() => handleAction(sub.id, entity.id, 'cancel')}
                              disabled={isProcessing}
                              className="px-2 py-1 text-xs font-medium text-red-700 bg-red-50 rounded hover:bg-red-100 disabled:opacity-50"
                            >
                              Cancel
                            </button>
                          </div>
                        )}

                        {['cancelled', 'expired'].includes(sub.status) && (
                          <button
                            onClick={() => setExpandedEntity(isExpanded ? null : entity.id)}
                            className="px-2 py-1 text-xs font-medium text-blue-700 bg-blue-50 rounded hover:bg-blue-100"
                          >
                            Re-enroll
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        onClick={() => setExpandedEntity(isExpanded ? null : entity.id)}
                        className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
                      >
                        Enable Monitoring
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded enrollment/settings form */}
                {isExpanded && (
                  <div className="border-t border-gray-200 bg-gray-50 p-4 space-y-4">
                    {/* Pull history (if existing subscription) */}
                    {sub && sub.pull_history && sub.pull_history.length > 0 && (
                      <div className="mb-4">
                        <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">
                          Pull History ({sub.total_pulls_completed} completed — ${sub.total_billed.toFixed(2)} total billed)
                        </p>
                        <div className="space-y-1">
                          {sub.pull_history.slice(-5).reverse().map((pull, i) => (
                            <div key={i} className="flex items-center gap-2 text-xs bg-white px-3 py-1.5 rounded border border-gray-100">
                              <span className={`w-2 h-2 rounded-full ${
                                pull.status === 'completed' ? 'bg-green-500' :
                                pull.status === 'queued' ? 'bg-blue-500' :
                                'bg-red-500'
                              }`} />
                              <span className="text-gray-700">{new Date(pull.date).toLocaleDateString()}</span>
                              <span className="text-gray-400">—</span>
                              <span className="text-gray-600">{pull.status}</span>
                              {pull.transcript_count > 0 && (
                                <span className="text-gray-400">({pull.transcript_count} files)</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* AI Summary */}
                    {sub?.latest_summary && (
                      <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 mb-4">
                        <p className="text-xs font-semibold text-indigo-700 mb-1">AI Summary (Latest Update)</p>
                        <p className="text-sm text-indigo-900">{sub.latest_summary}</p>
                        {sub.latest_summary_at && (
                          <p className="text-xs text-indigo-500 mt-1">{new Date(sub.latest_summary_at).toLocaleDateString()}</p>
                        )}
                      </div>
                    )}

                    {/* Frequency selection */}
                    <div>
                      <label className="block text-xs font-medium text-gray-700 mb-2">Update Frequency</label>
                      <div className="grid grid-cols-4 gap-2">
                        {FREQUENCY_OPTIONS.map((opt) => (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => setFrequency(opt.value)}
                            className={`p-2 text-center rounded-lg border text-sm transition-colors ${
                              frequency === opt.value
                                ? 'border-blue-500 bg-blue-50 text-blue-700 font-medium'
                                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                            }`}
                          >
                            <p className="font-medium">{opt.label}</p>
                            <p className="text-xs text-gray-400">{opt.description}</p>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Custom interval */}
                    {frequency === 'custom' && (
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          Interval (days)
                        </label>
                        <input
                          type="number"
                          min={1}
                          max={365}
                          value={customDays}
                          onChange={(e) => setCustomDays(parseInt(e.target.value) || 30)}
                          className="w-32 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                      </div>
                    )}

                    {/* Date pickers */}
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          First Pull Date <span className="text-gray-400">(optional)</span>
                        </label>
                        <input
                          type="date"
                          value={nextPullDate}
                          onChange={(e) => setNextPullDate(e.target.value)}
                          min={new Date().toISOString().split('T')[0]}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                        <p className="text-xs text-gray-400 mt-1">
                          {nextPullDate ? `First pull: ${new Date(nextPullDate).toLocaleDateString()}` : 'Defaults based on frequency'}
                        </p>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-700 mb-1">
                          End Date <span className="text-gray-400">(optional, up to 10 years)</span>
                        </label>
                        <input
                          type="date"
                          value={expiresAt}
                          onChange={(e) => setExpiresAt(e.target.value)}
                          min={new Date().toISOString().split('T')[0]}
                          max={new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
                        />
                        <p className="text-xs text-gray-400 mt-1">
                          {expiresAt ? `Monitoring ends: ${new Date(expiresAt).toLocaleDateString()}` : 'Runs until cancelled or 8821 expires'}
                        </p>
                      </div>
                    </div>

                    {/* Cost estimate */}
                    <div className="bg-white border border-gray-200 rounded-lg p-3">
                      <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide mb-2">Estimated Cost</p>
                      <div className="flex items-center gap-4 text-sm">
                        {!sub || ['cancelled', 'expired'].includes(sub.status) ? (
                          <>
                            <span className="text-gray-600">Enrollment: <strong>$19.99</strong></span>
                            <span className="text-gray-400">+</span>
                            <span className="text-gray-600">Per update: <strong>$39.99</strong></span>
                            <span className="text-gray-400">=</span>
                            <span className="text-gray-900 font-semibold">
                              ${(19.99 + 39.99).toFixed(2)} first update
                            </span>
                          </>
                        ) : (
                          <span className="text-gray-600">Schedule change — no additional enrollment fee</span>
                        )}
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex gap-2">
                      {sub && sub.status === 'active' ? (
                        <button
                          onClick={() => handleUpdateSchedule(sub)}
                          disabled={isProcessing}
                          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
                        >
                          {isProcessing ? 'Saving...' : 'Update Schedule'}
                        </button>
                      ) : (
                        <button
                          onClick={() => handleEnroll(entity.id)}
                          disabled={isProcessing}
                          className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50"
                        >
                          {isProcessing ? 'Enrolling...' : `Enroll — $19.99 + $39.99/update`}
                        </button>
                      )}
                      <button
                        onClick={() => setExpandedEntity(null)}
                        className="px-4 py-2 text-gray-600 text-sm hover:text-gray-800"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
