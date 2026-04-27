'use client';

/**
 * ManualEntryFlow — extracted from app/new/page.tsx (ManualEntryTab) so
 * the manual entry workflow can live at /new/manual for analytics
 * tracking. Identical behavior to the prior tabbed version, including
 * the MOD-200 idempotency guard for double-click submissions.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase';

const ENTITY_TRANSCRIPT_PRICE = 19.99;

export function ManualEntryFlow() {
  const router = useRouter();
  const supabase = createClient();

  const [loanNumber, setLoanNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [entities, setEntities] = useState([
    { id: '1', entityName: '', tid: '', tidKind: 'EIN' as 'EIN' | 'SSN', formType: '1040', years: [] as string[], signerEmail: '', address: '', city: '', state: '', zipCode: '', entityTranscript: false },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentYear = new Date().getFullYear();
  const TAX_YEARS = Array.from({ length: 6 }, (_, i) => String(currentYear - i));

  const addEntity = () => {
    setEntities([
      ...entities,
      { id: Math.random().toString(36).substr(2, 9), entityName: '', tid: '', tidKind: 'EIN', formType: '1040', years: [], signerEmail: '', address: '', city: '', state: '', zipCode: '', entityTranscript: false },
    ]);
  };

  const removeEntity = (id: string) => {
    if (entities.length > 1) setEntities(entities.filter((e) => e.id !== id));
  };

  const updateEntity = (id: string, updates: Partial<(typeof entities)[0]>) => {
    setEntities(entities.map((e) => (e.id === id ? { ...e, ...updates } : e)));
  };

  const toggleYear = (id: string, year: string) => {
    setEntities(entities.map((e) => {
      if (e.id !== id) return e;
      const newYears = e.years.includes(year) ? e.years.filter((y) => y !== year) : [...e.years, year];
      return { ...e, years: newYears };
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!loanNumber.trim()) { setError('Loan number is required'); return; }
    for (const ent of entities) {
      if (!ent.entityName.trim()) { setError('All entities need a name'); return; }
      if (!ent.tid.trim()) { setError('All entities need a Tax ID'); return; }
      if (!ent.address.trim()) { setError('All entities need an address for the 8821 form'); return; }
      if (!ent.city.trim()) { setError('All entities need a city'); return; }
      if (!ent.state.trim()) { setError('All entities need a state'); return; }
      if (!ent.zipCode.trim()) { setError('All entities need a ZIP code'); return; }
      if (!ent.signerEmail.trim()) { setError('All entities need a signer email for 8821 delivery'); return; }
      if (ent.years.length === 0) { setError('Select at least one tax year per entity'); return; }
    }

    setIsLoading(true);
    let navigating = false;

    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setError('Not authenticated'); return; }

      const { data: profile } = await supabase
        .from('profiles')
        .select('client_id')
        .eq('id', user.id)
        .single() as { data: { client_id: string | null } | null; error: unknown };

      if (!profile?.client_id) { setError('No client associated'); return; }

      const sixtySecondsAgo = new Date(Date.now() - 60_000).toISOString();
      const { data: recentDup } = await supabase
        .from('requests')
        .select('id')
        .eq('client_id', profile.client_id)
        .eq('requested_by', user.id)
        .eq('loan_number', loanNumber.trim())
        .gte('created_at', sixtySecondsAgo)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle() as { data: { id: string } | null; error: unknown };

      if (recentDup?.id) {
        setSubmitted(true);
        navigating = true;
        router.push(`/request/${recentDup.id}`);
        return;
      }

      const { data: req, error: reqError } = await supabase
        .from('requests')
        .insert({
          client_id: profile.client_id,
          requested_by: user.id,
          loan_number: loanNumber.trim(),
          intake_method: 'manual',
          status: 'submitted',
          notes: notes || null,
        })
        .select()
        .single() as { data: { id: string } | null; error: unknown };

      if (reqError || !req) { setError('Failed to create request'); return; }

      const entitiesData = entities.map((ent) => ({
        request_id: req.id,
        entity_name: ent.entityName,
        tid: ent.tid,
        tid_kind: ent.tidKind,
        address: ent.address || null,
        city: ent.city || null,
        state: ent.state || null,
        zip_code: ent.zipCode || null,
        form_type: ent.formType,
        years: ent.years,
        signer_email: ent.signerEmail || null,
        status: 'pending',
        gross_receipts: ent.entityTranscript ? {
          entity_transcript_order: {
            requested: true,
            price: ENTITY_TRANSCRIPT_PRICE,
            ordered_at: new Date().toISOString(),
          },
        } : null,
      }));

      const { error: entError } = await supabase.from('request_entities').insert(entitiesData);
      if (entError) { setError('Failed to create entities'); return; }

      const etCount = entities.filter(ent => ent.entityTranscript).length;
      if (etCount > 0) {
        try {
          await fetch('/api/notify/entity-transcript', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              request_id: req.id,
              loan_number: loanNumber.trim(),
              entity_count: etCount,
            }),
          });
        } catch (notifyErr) {
          console.error('Failed to send manager notification:', notifyErr);
        }
      }

      setSubmitted(true);
      navigating = true;
      router.push(`/request/${req.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      if (!navigating) setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-8">
        <h2 className="text-xl font-bold text-mt-dark mb-6">Request Info</h2>
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">Loan / Application Number <span className="text-red-500">*</span></label>
            <input type="text" value={loanNumber} onChange={(e) => setLoanNumber(e.target.value)} placeholder="e.g., 12345" disabled={isLoading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
          </div>
          <div>
            <label className="block text-sm font-semibold text-mt-dark mb-2">Notes <span className="text-gray-400 font-normal">(optional)</span></label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any additional info..." rows={3} disabled={isLoading}
              className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
          </div>
        </div>
      </div>

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
                <button type="button" onClick={() => removeEntity(entity.id)} disabled={isLoading}
                  className="text-red-600 hover:text-red-700 font-medium text-sm disabled:opacity-50">Remove</button>
              )}
            </div>

            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-semibold text-mt-dark mb-2">Entity Name <span className="text-red-500">*</span></label>
                  <input type="text" value={entity.entityName} onChange={(e) => updateEntity(entity.id, { entityName: e.target.value })}
                    placeholder="Business or individual name" disabled={isLoading}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-mt-dark mb-2">Tax ID <span className="text-red-500">*</span></label>
                  <div className="flex gap-3">
                    <select value={entity.tidKind} onChange={(e) => updateEntity(entity.id, { tidKind: e.target.value as 'EIN' | 'SSN' })} disabled={isLoading}
                      className="px-3 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50">
                      <option value="EIN">EIN</option>
                      <option value="SSN">SSN</option>
                    </select>
                    <input type="text" value={entity.tid} onChange={(e) => updateEntity(entity.id, { tid: e.target.value })}
                      placeholder={entity.tidKind === 'EIN' ? 'XX-XXXXXXX' : 'XXX-XX-XXXX'} disabled={isLoading}
                      className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 font-mono" />
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold text-mt-dark mb-2">Address <span className="text-red-500">*</span></label>
                <input type="text" value={entity.address || ''} onChange={(e) => updateEntity(entity.id, { address: e.target.value })}
                  placeholder="Street address" disabled={isLoading}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-semibold text-mt-dark mb-2">City <span className="text-red-500">*</span></label>
                  <input type="text" value={entity.city || ''} onChange={(e) => updateEntity(entity.id, { city: e.target.value })}
                    placeholder="City" disabled={isLoading}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-mt-dark mb-2">State <span className="text-red-500">*</span></label>
                  <input type="text" value={entity.state || ''} onChange={(e) => updateEntity(entity.id, { state: e.target.value })}
                    placeholder="TX" maxLength={2} disabled={isLoading}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-mt-dark mb-2">ZIP <span className="text-red-500">*</span></label>
                  <input type="text" value={entity.zipCode || ''} onChange={(e) => updateEntity(entity.id, { zipCode: e.target.value })}
                    placeholder="77489" maxLength={10} disabled={isLoading}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold text-mt-dark mb-2">Signer Email <span className="text-red-500">*</span></label>
                <input type="email" value={entity.signerEmail} onChange={(e) => updateEntity(entity.id, { signerEmail: e.target.value })}
                  placeholder="signer@email.com" disabled={isLoading}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50" />
                <p className="text-xs text-gray-400 mt-1">Email address of the person who will sign the 8821 form</p>
              </div>
              <div>
                <label className="block text-sm font-semibold text-mt-dark mb-2">Form Type</label>
                <select value={entity.formType} onChange={(e) => updateEntity(entity.id, { formType: e.target.value })} disabled={isLoading}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50">
                  <option value="1040">1040 (Individual)</option>
                  <option value="1065">1065 (Partnership)</option>
                  <option value="1120">1120 (Corporation)</option>
                  <option value="1120S">1120S (S-Corp)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold text-mt-dark mb-3">Tax Years <span className="text-red-500">*</span></label>
                <div className="flex flex-wrap gap-3">
                  {TAX_YEARS.map((year) => (
                    <label key={year} className="flex items-center gap-2">
                      <input type="checkbox" checked={entity.years.includes(year)} onChange={() => toggleYear(entity.id, year)} disabled={isLoading}
                        className="w-4 h-4 rounded border-gray-300 text-mt-green focus:ring-mt-green disabled:opacity-50" />
                      <span className="text-gray-700">{year}</span>
                    </label>
                  ))}
                </div>
              </div>

              {entity.tidKind === 'EIN' && (
                <div className={`border rounded-lg p-4 transition-colors ${entity.entityTranscript ? 'border-blue-400 bg-blue-50' : 'border-gray-200 bg-gray-50'}`}>
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input type="checkbox" checked={entity.entityTranscript}
                      onChange={() => updateEntity(entity.id, { entityTranscript: !entity.entityTranscript })} disabled={isLoading}
                      className="w-5 h-5 mt-0.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50" />
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-mt-dark text-sm">Add Entity Transcript</span>
                        <span className="text-blue-600 font-bold text-sm">${ENTITY_TRANSCRIPT_PRICE.toFixed(2)}</span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1">Confirms IRS filing requirements before pulling income transcripts. Prevents blank results from requesting the wrong form type (e.g., ordering 1065 when entity files 1120).</p>
                    </div>
                  </label>
                </div>
              )}
            </div>
          </div>
        ))}

        <button type="button" onClick={addEntity} disabled={isLoading}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-50 font-medium">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Another Entity
        </button>
      </div>

      {entities.some(e => e.entityTranscript) && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-sm font-semibold text-mt-dark mb-3">Order Summary</h3>
          <div className="space-y-2 text-sm">
            {entities.filter(e => e.entityTranscript).map((e, i) => (
              <div key={e.id} className="flex justify-between text-gray-600">
                <span>Entity Transcript — {e.entityName || `Entity ${i + 1}`}</span>
                <span className="font-medium">${ENTITY_TRANSCRIPT_PRICE.toFixed(2)}</span>
              </div>
            ))}
            <div className="border-t pt-2 mt-2 flex justify-between font-bold text-mt-dark">
              <span>Entity Transcript Add-ons</span>
              <span>${(entities.filter(e => e.entityTranscript).length * ENTITY_TRANSCRIPT_PRICE).toFixed(2)}</span>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-2">Standard transcript verification fees apply separately per entity.</p>
        </div>
      )}

      <button type="submit" disabled={isLoading || submitted}
        className="w-full bg-mt-green text-white py-4 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-lg">
        {submitted ? '✓ Submitted — redirecting…' : isLoading ? 'Submitting…' : 'Submit Request'}
      </button>
    </form>
  );
}
