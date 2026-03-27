'use client';

import { useState } from 'react';

interface RoleSelectorProps {
  userId: string;
  currentRole: string;
  callerRole: 'admin' | 'manager';
  userName: string;
}

export function RoleSelector({ userId, currentRole, callerRole }: RoleSelectorProps) {
  const [role, setRole] = useState(currentRole);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const availableRoles = callerRole === 'admin'
    ? ['processor', 'manager', 'expert']
    : ['processor', 'manager'];

  const handleChange = async (newRole: string) => {
    if (newRole === role) return;

    setSaving(true);
    setError('');
    setSaved(false);

    try {
      const res = await fetch('/api/admin/update-role', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, newRole }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to update role');
      }

      setRole(newRole);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
      // Revert
      setRole(role);
    } finally {
      setSaving(false);
    }
  };

  const roleColors: Record<string, string> = {
    processor: 'bg-blue-100 text-blue-800',
    manager: 'bg-purple-100 text-purple-800',
    expert: 'bg-amber-100 text-amber-800',
    admin: 'bg-red-100 text-red-800',
  };

  // Admin and expert roles that the caller can't change
  if (currentRole === 'admin') {
    return (
      <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${roleColors.admin}`}>
        Admin
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={role}
        onChange={(e) => handleChange(e.target.value)}
        disabled={saving}
        className={`text-xs font-semibold px-2 py-1 rounded border-0 cursor-pointer ${roleColors[role] || 'bg-gray-100 text-gray-600'} ${saving ? 'opacity-50' : ''}`}
      >
        {availableRoles.map((r) => (
          <option key={r} value={r}>
            {r.charAt(0).toUpperCase() + r.slice(1)}
          </option>
        ))}
      </select>
      {saving && <span className="text-xs text-gray-400">Saving...</span>}
      {saved && <span className="text-xs text-green-600">Updated</span>}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </div>
  );
}
