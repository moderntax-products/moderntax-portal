'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface Client {
  id: string;
  name: string;
}

interface InviteUserFormProps {
  clients?: Client[];
  managerMode?: boolean;  // When true, locks role to processor and hides client picker
  internalMode?: boolean; // When true, only allows admin/expert roles and hides client picker
  defaultRole?: string;   // Pre-select a role (e.g. 'expert')
}

interface InviteResult {
  id: string;
  email: string;
  fullName: string;
  role: string;
  tempPassword: string;
}

interface InviteResponse {
  success: boolean;
  emailSent: boolean;
  emailError: string | null;
  user: InviteResult;
}

export function InviteUserForm({ clients = [], managerMode = false, internalMode = false, defaultRole }: InviteUserFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState(defaultRole || (internalMode ? 'admin' : 'processor'));
  const [clientId, setClientId] = useState(clients[0]?.id || '');
  const [newClientName, setNewClientName] = useState('');

  const isInternalRole = role === 'admin' || role === 'expert';
  const isNewClient = clientId === '__new__';
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<InviteResult | null>(null);
  const [emailStatus, setEmailStatus] = useState<{ sent: boolean; error: string | null } | null>(null);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    setEmailStatus(null);

    try {
      let resolvedClientId = isInternalRole ? null : clientId;

      // If adding a new client, create it first
      if (!isInternalRole && isNewClient) {
        if (!newClientName.trim()) {
          setError('Please enter a client name');
          setLoading(false);
          return;
        }

        const clientRes = await fetch('/api/admin/create-client', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newClientName.trim() }),
        });

        const clientData = await clientRes.json();

        if (!clientRes.ok) {
          setError(clientData.error || 'Failed to create client');
          setLoading(false);
          return;
        }

        resolvedClientId = clientData.client.id;
      }

      const res = await fetch('/api/admin/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, fullName, role, clientId: resolvedClientId }),
      });

      const data = await res.json() as InviteResponse;

      if (!res.ok) {
        setError((data as any).error || 'Failed to invite user');
        return;
      }

      setResult(data.user);
      setEmailStatus({ sent: data.emailSent, error: data.emailError });
      setEmail('');
      setFullName('');
      setNewClientName('');
      setRole(defaultRole || (internalMode ? 'admin' : 'processor'));

      // Refresh the page to update client list if a new client was created
      if (isNewClient) {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite user');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={handleInvite} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Jane Smith"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@company.com"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent text-sm"
            />
          </div>
          {!managerMode && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent text-sm bg-white"
              >
                {internalMode ? (
                  <>
                    <option value="admin">Admin</option>
                    <option value="expert">Expert (IRS Practitioner)</option>
                  </>
                ) : (
                  <>
                    <option value="processor">Processor</option>
                    <option value="manager">Manager</option>
                  </>
                )}
              </select>
            </div>
          )}
          {!managerMode && !internalMode && !isInternalRole && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Client</label>
              <select
                value={clientId}
                onChange={(e) => {
                  setClientId(e.target.value);
                  if (e.target.value !== '__new__') {
                    setNewClientName('');
                  }
                }}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent text-sm bg-white"
              >
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
                <option value="__new__">+ Add new client...</option>
              </select>
            </div>
          )}
          {!managerMode && !internalMode && !isInternalRole && isNewClient && (
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">New Client Name</label>
              <input
                type="text"
                value={newClientName}
                onChange={(e) => setNewClientName(e.target.value)}
                placeholder="e.g. Acme Lending Group"
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent text-sm"
              />
            </div>
          )}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="px-6 py-2.5 bg-mt-green text-white rounded-lg font-semibold text-sm hover:bg-opacity-90 disabled:opacity-50 transition-colors"
        >
          {loading ? 'Creating...' : isNewClient ? 'Create Client & Invite User' : 'Invite User'}
        </button>
      </form>

      {/* Success Result */}
      {result && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-5 space-y-3">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <p className="font-semibold text-green-800">User Created Successfully</p>
          </div>
          <div className="bg-white rounded-lg border border-green-200 p-4 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-500">Name:</span>
              <span className="font-medium text-gray-900">{result.fullName}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Email:</span>
              <span className="font-medium text-gray-900">{result.email}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Role:</span>
              <span className="font-medium text-gray-900 capitalize">{result.role}</span>
            </div>
            <hr className="border-gray-200" />
            <div className="flex justify-between items-center">
              <span className="text-gray-500">Temporary Password:</span>
              <code className="font-mono text-sm bg-yellow-50 px-2 py-1 rounded border border-yellow-200 text-yellow-800 select-all">
                {result.tempPassword}
              </code>
            </div>
          </div>
          {emailStatus && (
            emailStatus.sent ? (
              <p className="text-xs text-green-600">
                ✅ Welcome email sent to {result.email} with login instructions.
              </p>
            ) : (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 px-3 py-2 rounded">
                ⚠️ Welcome email could not be sent{emailStatus.error ? `: ${emailStatus.error}` : ''}. Please share the temporary password manually.
              </div>
            )
          )}
          <p className="text-xs text-green-600">
            Share the temporary password securely with the user. They should change it on first login.
          </p>
        </div>
      )}
    </div>
  );
}
