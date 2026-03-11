'use client';

import { useState, useEffect } from 'react';

interface Expert {
  id: string;
  email: string;
  full_name: string | null;
}

interface AdminExpertAssignProps {
  entityId: string;
  entityName: string;
  currentAssignment?: {
    id: string;
    expert_id: string;
    status: string;
    sla_deadline: string;
    expert_notes: string | null;
    miss_reason: string | null;
    profiles?: { full_name: string | null; email: string };
  } | null;
  onAssigned?: () => void;
}

export function AdminExpertAssign({
  entityId,
  entityName,
  currentAssignment,
  onAssigned,
}: AdminExpertAssignProps) {
  const [experts, setExperts] = useState<Expert[]>([]);
  const [selectedExpert, setSelectedExpert] = useState('');
  const [loading, setLoading] = useState(false);
  const [fetchingExperts, setFetchingExperts] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    if (showForm && experts.length === 0) {
      fetchExperts();
    }
  }, [showForm]);

  const fetchExperts = async () => {
    setFetchingExperts(true);
    try {
      const res = await fetch('/api/admin/expert/list');
      const data = await res.json();
      if (res.ok) {
        setExperts(data.experts || []);
      }
    } catch (err) {
      console.error('Failed to fetch experts:', err);
    } finally {
      setFetchingExperts(false);
    }
  };

  const handleAssign = async () => {
    if (!selectedExpert) {
      setError('Please select an expert');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/admin/expert/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entityIds: [entityId],
          expertId: selectedExpert,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to assign');
        return;
      }

      setShowForm(false);
      if (onAssigned) onAssigned();
      else window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Assignment failed');
    } finally {
      setLoading(false);
    }
  };

  // Show current assignment status
  if (currentAssignment && ['assigned', 'in_progress'].includes(currentAssignment.status)) {
    const expertName = currentAssignment.profiles?.full_name || currentAssignment.profiles?.email || 'Expert';
    return (
      <div className="text-xs space-y-1">
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded-full font-medium ${
            currentAssignment.status === 'in_progress'
              ? 'bg-amber-100 text-amber-800'
              : 'bg-blue-100 text-blue-800'
          }`}>
            {currentAssignment.status === 'in_progress' ? 'In Progress' : 'Assigned'}
          </span>
          <span className="text-gray-600">to {expertName}</span>
        </div>
        {currentAssignment.miss_reason && (
          <p className="text-red-600">Issue: {currentAssignment.miss_reason}</p>
        )}
        {currentAssignment.expert_notes && (
          <p className="text-gray-500">Notes: {currentAssignment.expert_notes}</p>
        )}
        <button
          onClick={() => setShowForm(!showForm)}
          className="text-blue-600 hover:text-blue-800 font-medium"
        >
          Reassign
        </button>
        {showForm && (
          <div className="mt-2 p-3 bg-gray-50 rounded-lg border space-y-2">
            {fetchingExperts ? (
              <p className="text-gray-500">Loading experts...</p>
            ) : (
              <>
                <select
                  value={selectedExpert}
                  onChange={(e) => setSelectedExpert(e.target.value)}
                  className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white"
                >
                  <option value="">Select expert...</option>
                  {experts.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.full_name || e.email}
                    </option>
                  ))}
                </select>
                {error && <p className="text-red-600 text-xs">{error}</p>}
                <button
                  onClick={handleAssign}
                  disabled={loading}
                  className="px-3 py-1.5 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? 'Assigning...' : 'Reassign'}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // No assignment yet - show assign button
  if (!showForm) {
    return (
      <button
        onClick={() => setShowForm(true)}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-200"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
        Assign to Expert
      </button>
    );
  }

  // Assignment form
  return (
    <div className="p-3 bg-emerald-50 rounded-lg border border-emerald-200 space-y-2">
      <p className="text-xs font-medium text-emerald-800">
        Assign &ldquo;{entityName}&rdquo; to Expert
      </p>
      {fetchingExperts ? (
        <p className="text-xs text-gray-500">Loading experts...</p>
      ) : experts.length === 0 ? (
        <p className="text-xs text-gray-500">No experts found. Invite one from the Team page.</p>
      ) : (
        <>
          <select
            value={selectedExpert}
            onChange={(e) => setSelectedExpert(e.target.value)}
            className="w-full px-2 py-1.5 border border-gray-300 rounded text-sm bg-white"
          >
            <option value="">Select expert...</option>
            {experts.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name || e.email}
              </option>
            ))}
          </select>
          {error && <p className="text-red-600 text-xs">{error}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleAssign}
              disabled={loading}
              className="px-3 py-1.5 bg-emerald-600 text-white text-xs rounded hover:bg-emerald-700 disabled:opacity-50"
            >
              {loading ? 'Assigning...' : 'Assign'}
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="px-3 py-1.5 text-gray-600 text-xs hover:text-gray-800"
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
