'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';
import { FormType } from '@/lib/types';
import Link from 'next/link';

interface Entity {
  id: string;
  entityName: string;
  ein: string;
  formType: FormType;
  years: string[];
}

const FORM_TYPES = [
  { value: FormType.FORM_1040, label: 'Form 1040 (Individual)' },
  { value: FormType.FORM_1065, label: 'Form 1065 (Partnership)' },
  { value: FormType.FORM_1120, label: 'Form 1120 (Corporation)' },
  { value: FormType.FORM_1120S, label: 'Form 1120S (S-Corp)' },
];

const TAX_YEARS = ['2024', '2023', '2022', '2021'];

export default function NewRequestPage() {
  const router = useRouter();
  const supabase = createClient();

  const [accountNumber, setAccountNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [entities, setEntities] = useState<Entity[]>([
    {
      id: '1',
      entityName: '',
      ein: '',
      formType: FormType.FORM_1040,
      years: [],
    },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addEntity = () => {
    const newId = Math.random().toString(36).substr(2, 9);
    setEntities([
      ...entities,
      {
        id: newId,
        entityName: '',
        ein: '',
        formType: FormType.FORM_1040,
        years: [],
      },
    ]);
  };

  const removeEntity = (id: string) => {
    if (entities.length > 1) {
      setEntities(entities.filter((e) => e.id !== id));
    }
  };

  const updateEntity = (id: string, updates: Partial<Entity>) => {
    setEntities(
      entities.map((e) => (e.id === id ? { ...e, ...updates } : e))
    );
  };

  const toggleYear = (id: string, year: string) => {
    setEntities(
      entities.map((e) => {
        if (e.id === id) {
          const newYears = e.years.includes(year)
            ? e.years.filter((y) => y !== year)
            : [...e.years, year];
          return { ...e, years: newYears };
        }
        return e;
      })
    );
  };

  const validateEIN = (ein: string): boolean => {
    const einRegex = /^\d{2}-\d{7}$/;
    return einRegex.test(ein);
  };

  const validateForm = (): string | null => {
    if (!accountNumber.trim()) {
      return 'Account number is required';
    }

    for (const entity of entities) {
      if (!entity.entityName.trim()) {
        return 'All entities must have a name';
      }
      if (!entity.ein.trim()) {
        return 'All entities must have an EIN';
      }
      if (!validateEIN(entity.ein)) {
        return 'EIN must be in format XX-XXXXXXX';
      }
      if (entity.years.length === 0) {
        return 'Each entity must have at least one tax year selected';
      }
    }

    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsLoading(true);

    try {
      // Get current user
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError('Not authenticated');
        return;
      }

      // Get user profile to get client_id
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('client_id')
        .eq('id', user.id)
        .single();

      if (profileError || !profile) {
        setError('Failed to get user profile');
        return;
      }

      // Create request
      const { data: request, error: requestError } = await supabase
        .from('requests')
        .insert({
          client_id: profile.client_id,
          requested_by: user.id,
          account_number: accountNumber,
          status: 'submitted',
          notes: notes || null,
        })
        .select('*')
        .single();

      if (requestError || !request) {
        setError('Failed to create request');
        return;
      }

      // Create entities
      const entitiesData = entities.map((e) => ({
        request_id: request.id,
        entity_name: e.entityName,
        ein: e.ein,
        form_type: e.formType,
        years: e.years,
        status: 'submitted',
      }));

      const { error: entitiesError } = await supabase
        .from('request_entities')
        .insert(entitiesData);

      if (entitiesError) {
        setError('Failed to create entities');
        return;
      }

      // Call webhook to send confirmation email
      try {
        await fetch('/api/webhook/request-created', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId: request.id,
            userId: user.id,
            accountNumber: accountNumber,
          }),
        });
      } catch (err) {
        console.error('Webhook error:', err);
        // Don't fail if webhook fails
      }

      // Redirect to request detail page
      router.push(`/request/${request.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-mt-dark">New Verification Request</h1>
            <p className="text-gray-600 mt-1">Submit entities for IRS transcript verification</p>
          </div>
          <Link
            href="/"
            className="text-gray-600 hover:text-gray-900 font-medium"
          >
            ← Back to Dashboard
          </Link>
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <form onSubmit={handleSubmit} className="space-y-8">
          {error && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-700 text-sm">{error}</p>
            </div>
          )}

          {/* Account Information */}
          <div className="bg-white rounded-lg shadow p-8">
            <h2 className="text-xl font-bold text-mt-dark mb-6">Account Information</h2>

            <div className="space-y-6">
              <div>
                <label htmlFor="accountNumber" className="block text-sm font-semibold text-mt-dark mb-2">
                  Account Number <span className="text-red-500">*</span>
                </label>
                <input
                  id="accountNumber"
                  type="text"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  placeholder="e.g., ACC-12345"
                  disabled={isLoading}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>

              <div>
                <label htmlFor="notes" className="block text-sm font-semibold text-mt-dark mb-2">
                  Notes <span className="text-gray-400 font-normal">(optional)</span>
                </label>
                <textarea
                  id="notes"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="Any additional information about this request..."
                  rows={4}
                  disabled={isLoading}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                />
              </div>
            </div>
          </div>

          {/* Entities */}
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-bold text-mt-dark">Entities</h2>
              <p className="text-sm text-gray-600">{entities.length} entity/entities</p>
            </div>

            {entities.map((entity, index) => (
              <div key={entity.id} className="bg-white rounded-lg shadow p-8">
                <div className="flex justify-between items-start mb-6">
                  <h3 className="text-lg font-semibold text-mt-dark">Entity {index + 1}</h3>
                  {entities.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeEntity(entity.id)}
                      disabled={isLoading}
                      className="text-red-600 hover:text-red-700 font-medium text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Remove
                    </button>
                  )}
                </div>

                <div className="space-y-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                      <label className="block text-sm font-semibold text-mt-dark mb-2">
                        Entity Name <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={entity.entityName}
                        onChange={(e) => updateEntity(entity.id, { entityName: e.target.value })}
                        placeholder="Business or individual name"
                        disabled={isLoading}
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-semibold text-mt-dark mb-2">
                        EIN <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        value={entity.ein}
                        onChange={(e) => updateEntity(entity.id, { ein: e.target.value.replace(/[^\d-]/g, '') })}
                        placeholder="XX-XXXXXXX"
                        disabled={isLoading}
                        className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed font-mono"
                      />
                      <p className="text-xs text-gray-500 mt-1">Format: XX-XXXXXXX</p>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-mt-dark mb-2">
                      Form Type <span className="text-red-500">*</span>
                    </label>
                    <select
                      value={entity.formType}
                      onChange={(e) => updateEntity(entity.id, { formType: e.target.value as FormType })}
                      disabled={isLoading}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {FORM_TYPES.map((ft) => (
                        <option key={ft.value} value={ft.value}>
                          {ft.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-mt-dark mb-3">
                      Tax Years <span className="text-red-500">*</span>
                    </label>
                    <div className="space-y-2">
                      {TAX_YEARS.map((year) => (
                        <label key={year} className="flex items-center">
                          <input
                            type="checkbox"
                            checked={entity.years.includes(year)}
                            onChange={() => toggleYear(entity.id, year)}
                            disabled={isLoading}
                            className="w-4 h-4 rounded border-gray-300 text-mt-green focus:ring-mt-green disabled:opacity-50 disabled:cursor-not-allowed"
                          />
                          <span className="ml-3 text-gray-700">{year}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {/* Add Entity Button */}
            <button
              type="button"
              onClick={addEntity}
              disabled={isLoading}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Another Entity
            </button>
          </div>

          {/* Submit Section */}
          <div className="flex gap-4">
            <button
              type="submit"
              disabled={isLoading}
              className="flex-1 bg-mt-green text-white py-4 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-lg"
            >
              {isLoading ? 'Submitting...' : 'Submit Request'}
            </button>
            <Link
              href="/"
              className="flex items-center justify-center px-8 py-4 border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors font-semibold"
            >
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
