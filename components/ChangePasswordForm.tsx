'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase';

export function ChangePasswordForm() {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess(false);

    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setSaving(true);
    try {
      const supabase = createClient();
      const { error: updateError } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (updateError) {
        setError(updateError.message);
        return;
      }

      setSuccess(true);
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => setSuccess(false), 5000);
    } catch (err) {
      setError('Failed to update password');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">New Password</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Min 8 characters"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-mt-green"
            required
            minLength={8}
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Confirm Password</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Re-enter password"
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-mt-green focus:border-mt-green"
            required
            minLength={8}
          />
        </div>
      </div>

      {error && (
        <p className="text-sm text-red-600">{error}</p>
      )}
      {success && (
        <p className="text-sm text-green-600">Password updated successfully.</p>
      )}

      <button
        type="submit"
        disabled={saving || !newPassword || !confirmPassword}
        className={`px-6 py-2 rounded-lg text-sm font-semibold transition-colors ${
          newPassword && confirmPassword
            ? 'bg-mt-dark text-white hover:bg-mt-dark/90'
            : 'bg-gray-100 text-gray-400 cursor-not-allowed'
        }`}
      >
        {saving ? 'Updating...' : 'Update Password'}
      </button>
    </form>
  );
}
