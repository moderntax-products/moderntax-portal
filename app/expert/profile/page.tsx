'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { VoiceRecorder } from '@/components/VoiceRecorder';

interface ExpertProfile {
  full_name: string;
  caf_number: string;
  ptin: string;
  phone_number: string;
  fax_number: string;
  address: string;
  city: string;
  state: string;
  zip_code: string;
  sor_id: string;
  voice_sample_url: string;
}

interface IrsCredentialsStatus {
  hasSsn: boolean;
  hasDob: boolean;
  consentedAt: string | null;
  updatedAt: string | null;
  usedCount: number;
}

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP',
];

export default function ExpertProfilePage() {
  const router = useRouter();
  // Stable supabase client — see app/expert/page.tsx for the bug history.
  const supabase = useMemo(() => createClient(), []);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [profile, setProfile] = useState<ExpertProfile>({
    full_name: '',
    caf_number: '',
    ptin: '',
    phone_number: '',
    fax_number: '',
    address: '',
    city: '',
    state: '',
    zip_code: '',
    sor_id: '',
    voice_sample_url: '',
  });

  // IRS Credentials (SSN/DOB) — separate from main profile form because
  // those values are write-only via /api/expert/credentials and never
  // returned in plaintext. Status is fetched on mount.
  const [credStatus, setCredStatus] = useState<IrsCredentialsStatus | null>(null);
  const [credsFormOpen, setCredsFormOpen] = useState(false);
  const [credsSaving, setCredsSaving] = useState(false);
  const [credsError, setCredsError] = useState<string | null>(null);
  const [ssnInput, setSsnInput] = useState('');
  const [dobInput, setDobInput] = useState('');
  const [consentChecked, setConsentChecked] = useState(false);

  useEffect(() => {
    async function loadProfile() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push('/login');
        return;
      }

      // Main profile fetch — voice_sample_url is fetched separately
      // because that column is added by migration-expert-voice.sql
      // which may not have run yet. Including it inline would 500 the
      // whole page on environments where the column doesn't exist.
      const { data: profileData, error: profileFetchError } = await supabase
        .from('profiles')
        .select('role, full_name, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code, sor_id')
        .eq('id', user.id)
        .single() as { data: any; error: any };

      // Distinguish "we got data and the role is wrong" (real auth failure
      // → bounce) from "fetch errored" (network blip → show error and let
      // the user retry, don't redirect). Previous behaviour redirected on
      // any null profileData, which was indistinguishable from a transient
      // DNS / network failure and bounced experts back to /expert with no
      // explanation. Lots of pain on flaky wifi.
      if (profileFetchError) {
        setError(`Could not load your profile: ${profileFetchError.message}. Refresh to retry.`);
        setLoading(false);
        return;
      }
      if (!profileData) {
        setError('Profile not found. Please contact support.');
        setLoading(false);
        return;
      }
      if (!['expert', 'admin'].includes(profileData.role)) {
        router.push('/');
        return;
      }

      // Optional: pull voice_sample_url separately. Wrapped so a missing
      // column or fetch failure just leaves it blank — the VoiceRecorder
      // still works for new recordings.
      let voiceSampleUrl = '';
      try {
        const { data: voiceData } = await (supabase
          .from('profiles')
          .select('voice_sample_url')
          .eq('id', user.id)
          .single() as any) as { data: { voice_sample_url: string | null } | null };
        if (voiceData?.voice_sample_url) voiceSampleUrl = voiceData.voice_sample_url;
      } catch {
        // Column missing or transient failure — keep blank.
      }

      setProfile({
        full_name: profileData.full_name || '',
        caf_number: profileData.caf_number || '',
        ptin: profileData.ptin || '',
        phone_number: profileData.phone_number || '',
        fax_number: profileData.fax_number || '',
        address: profileData.address || '',
        city: profileData.city || '',
        state: profileData.state || '',
        zip_code: profileData.zip_code || '',
        sor_id: profileData.sor_id || '',
        voice_sample_url: voiceSampleUrl,
      });

      // Fetch IRS credentials presence (NEVER returns the SSN/DOB plaintext)
      try {
        const res = await fetch('/api/expert/credentials', { cache: 'no-store' });
        if (res.ok) setCredStatus(await res.json());
      } catch { /* non-fatal — section just shows "load failed" */ }

      setLoading(false);
    }

    loadProfile();
  }, [supabase, router]);

  const handleChange = (field: keyof ExpertProfile, value: string) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
    setError('');
    setSuccess(false);
  };

  const saveCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setCredsError(null);
    if (!consentChecked) {
      setCredsError('You must check the consent box to authorize use during IRS PPS calls.');
      return;
    }
    if (!/^\d{3}-?\d{2}-?\d{4}$/.test(ssnInput.trim())) {
      setCredsError('SSN must be 9 digits (with or without dashes).');
      return;
    }
    if (!dobInput) {
      setCredsError('Date of birth is required.');
      return;
    }
    setCredsSaving(true);
    try {
      const res = await fetch('/api/expert/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssn: ssnInput.trim(), dob: dobInput, consent: true }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setCredsError(j.error || `Save failed (status ${res.status})`);
      } else {
        // Re-fetch status to reflect the new presence flags
        const updated = await fetch('/api/expert/credentials', { cache: 'no-store' });
        if (updated.ok) setCredStatus(await updated.json());
        setSsnInput(''); setDobInput(''); setConsentChecked(false);
        setCredsFormOpen(false);
      }
    } catch (err: any) {
      setCredsError(err?.message || 'Save failed');
    } finally {
      setCredsSaving(false);
    }
  };

  const deleteCredentials = async () => {
    if (!confirm('Remove your stored SSN/DOB? You will not be eligible for new IRS PPS assignments until you re-enter them.')) return;
    setCredsSaving(true);
    setCredsError(null);
    try {
      await fetch('/api/expert/credentials', { method: 'DELETE' });
      const updated = await fetch('/api/expert/credentials', { cache: 'no-store' });
      if (updated.ok) setCredStatus(await updated.json());
    } finally { setCredsSaving(false); }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess(false);

    // Validate required fields
    if (!profile.full_name.trim()) {
      setError('Full name is required');
      setSaving(false);
      return;
    }
    if (!profile.caf_number.trim()) {
      setError('CAF number is required for 8821 form filing');
      setSaving(false);
      return;
    }
    if (!profile.ptin.trim()) {
      setError('PTIN is required for 8821 form filing');
      setSaving(false);
      return;
    }
    if (!profile.phone_number.trim()) {
      setError('Phone number is required for 8821 form filing');
      setSaving(false);
      return;
    }
    if (!profile.address.trim() || !profile.city.trim() || !profile.state.trim() || !profile.zip_code.trim()) {
      setError('Complete address is required for 8821 form filing');
      setSaving(false);
      return;
    }

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError('Not authenticated');
        setSaving(false);
        return;
      }

      const { error: updateError } = await (supabase
        .from('profiles')
        .update({
          full_name: profile.full_name.trim(),
          caf_number: profile.caf_number.trim(),
          ptin: profile.ptin.trim(),
          phone_number: profile.phone_number.trim(),
          fax_number: profile.fax_number.trim() || null,
          address: profile.address.trim(),
          city: profile.city.trim(),
          state: profile.state.trim(),
          zip_code: profile.zip_code.trim(),
          sor_id: profile.sor_id.trim() || null,
        } as any)
        .eq('id', user.id) as any);

      if (updateError) {
        setError(updateError.message);
        return;
      }

      setSuccess(true);
      setTimeout(() => {
        router.push('/expert');
      }, 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-500">Loading profile...</div>
      </div>
    );
  }

  const isProfileComplete = profile.caf_number && profile.ptin && profile.phone_number && profile.address;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Expert Profile Setup</h1>
          <p className="text-sm text-gray-500 mt-1">
            Enter your IRS practitioner credentials. This information is used to populate
            Section 2 (Designee) of Form 8821 for each assignment.
          </p>
        </div>

        {/* 8821 Section 2 Reference */}
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 mb-6">
          <div className="flex items-start gap-2">
            <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm font-semibold text-amber-800">Form 8821 — Section 2 (Designee)</p>
              <p className="text-xs text-amber-700 mt-1">
                These fields match the IRS Form 8821 designee section. Your CAF number, PTIN,
                name, address, and phone will be pre-filled on each 8821 form prepared for your assignments.
              </p>
            </div>
          </div>
        </div>

        {!isProfileComplete && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
            <p className="text-sm text-red-700 font-medium">
              ⚠️ Profile incomplete — you must fill in all required fields before you can process assignments.
            </p>
          </div>
        )}

        <form onSubmit={handleSave} className="bg-white rounded-lg shadow p-6 space-y-6">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Full Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={profile.full_name}
              onChange={(e) => handleChange('full_name', e.target.value)}
              placeholder="Jane Smith"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
            />
            <p className="text-xs text-gray-400 mt-1">As it appears on your IRS credentials</p>
          </div>

          {/* Address */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Street Address <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={profile.address}
              onChange={(e) => handleChange('address', e.target.value)}
              placeholder="123 Main Street"
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                City <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={profile.city}
                onChange={(e) => handleChange('city', e.target.value)}
                placeholder="Anytown"
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                State <span className="text-red-500">*</span>
              </label>
              <select
                value={profile.state}
                onChange={(e) => handleChange('state', e.target.value)}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm bg-white"
              >
                <option value="">Select...</option>
                {US_STATES.map((st) => (
                  <option key={st} value={st}>{st}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                ZIP Code <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={profile.zip_code}
                onChange={(e) => handleChange('zip_code', e.target.value)}
                placeholder="12345"
                required
                maxLength={10}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
              />
            </div>
          </div>

          {/* IRS Credentials */}
          <div className="border-t border-gray-200 pt-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">IRS Practitioner Credentials</h3>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  CAF Number <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={profile.caf_number}
                  onChange={(e) => handleChange('caf_number', e.target.value)}
                  placeholder="1234-56789R"
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm font-mono"
                />
                <p className="text-xs text-gray-400 mt-1">Centralized Authorization File number</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  PTIN <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={profile.ptin}
                  onChange={(e) => handleChange('ptin', e.target.value)}
                  placeholder="P12345678"
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm font-mono"
                />
                <p className="text-xs text-gray-400 mt-1">Preparer Tax Identification Number</p>
              </div>
            </div>
          </div>

          {/* Contact Info */}
          <div className="border-t border-gray-200 pt-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-4">Contact Information</h3>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Phone Number <span className="text-red-500">*</span>
                </label>
                <input
                  type="tel"
                  value={profile.phone_number}
                  onChange={(e) => handleChange('phone_number', e.target.value)}
                  placeholder="555-555-5555"
                  required
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Fax Number</label>
                <input
                  type="tel"
                  value={profile.fax_number}
                  onChange={(e) => handleChange('fax_number', e.target.value)}
                  placeholder="Optional — leave blank if you do not have one"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
                />
                <p className="text-xs text-gray-400 mt-1">Optional. Not required to complete your profile.</p>
              </div>
            </div>

            {/* SOR ID — added 2026-05-23 per Joel Abernathy's request (was the
                missing 4th field he couldn't enter through the form). */}
            <div className="mt-4">
              <label className="block text-sm font-medium text-gray-700 mb-1">SOR Mailbox ID</label>
              <input
                type="text"
                value={profile.sor_id}
                onChange={(e) => handleChange('sor_id', e.target.value)}
                placeholder="e.g. JOEL1971, MCA-R-31"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm font-mono"
              />
              <p className="text-xs text-gray-400 mt-1">
                Your IRS e-Services Secure Object Repository inbox short ID — where the IRS deposits transcripts after PPS calls.
              </p>
            </div>
          </div>

          {/* IRS Identity Verification (SSN + DOB) — separate section above
              the optional voice sample so it's never blocked by mic issues
              (see Joel Abernathy 2026-05-23 bug report). Posts to
              /api/expert/credentials which encrypts and never returns the
              plaintext back to the UI. */}
          <div className="border-t border-gray-200 pt-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-1">IRS Identity Verification (Required)</h3>
            <p className="text-xs text-gray-500 mb-4">
              The IRS rep verifies the practitioner&apos;s identity on every PPS call by asking for last 4 of SSN + date of birth.
              We store these encrypted (AES-256-GCM) and decrypt only at call time. They&apos;re never displayed back to you or anyone else.
            </p>

            {credStatus?.hasSsn && credStatus?.hasDob ? (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-4 flex items-center justify-between">
                <div className="text-sm">
                  <p className="font-semibold text-emerald-900">✓ SSN + DOB on file</p>
                  <p className="text-xs text-emerald-700 mt-0.5">
                    Consent given {credStatus.consentedAt ? new Date(credStatus.consentedAt).toLocaleDateString() : '—'} ·
                    used {credStatus.usedCount}× on IRS calls
                  </p>
                </div>
                <button type="button" onClick={deleteCredentials} disabled={credsSaving}
                  className="text-xs text-red-600 hover:text-red-800 underline disabled:opacity-50">
                  Remove
                </button>
              </div>
            ) : credsFormOpen ? (
              <div className="bg-gray-50 border border-gray-300 rounded-lg p-4 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Social Security Number</label>
                    <input type="text" inputMode="numeric" autoComplete="off"
                      value={ssnInput} onChange={e => setSsnInput(e.target.value)}
                      placeholder="123-45-6789"
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-700 mb-1">Date of Birth</label>
                    <input type="date" autoComplete="off"
                      value={dobInput} onChange={e => setDobInput(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded text-sm" />
                  </div>
                </div>
                <label className="flex items-start gap-2 text-xs text-gray-700">
                  <input type="checkbox" checked={consentChecked}
                    onChange={e => setConsentChecked(e.target.checked)}
                    className="mt-0.5 rounded border-gray-400" />
                  <span>
                    I authorize ModernTax to decrypt and use my SSN + DOB during automated IRS Practitioner Priority Service calls placed
                    on my behalf, solely for identity verification with the IRS rep. Encrypted at rest; never displayed; revocable at any time.
                  </span>
                </label>
                {credsError && (
                  <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded">{credsError}</div>
                )}
                <div className="flex items-center gap-2">
                  <button type="button" onClick={saveCredentials} disabled={credsSaving}
                    className="px-4 py-1.5 bg-emerald-600 text-white text-sm font-semibold rounded hover:bg-emerald-700 disabled:opacity-50">
                    {credsSaving ? 'Saving…' : 'Save IRS Credentials'}
                  </button>
                  <button type="button" onClick={() => { setCredsFormOpen(false); setSsnInput(''); setDobInput(''); setConsentChecked(false); setCredsError(null); }}
                    disabled={credsSaving}
                    className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900 disabled:opacity-50">
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setCredsFormOpen(true)}
                className="px-4 py-2 bg-indigo-600 text-white text-sm font-semibold rounded hover:bg-indigo-700">
                Add SSN + DOB
              </button>
            )}
          </div>

          {/* Voice Sample for IRS PPS Calls — EXPLICITLY OPTIONAL.
              Joel Abernathy reported 2026-05-23 he thought this was a hard
              prerequisite for the SSN/DOB section. It is not. Voice clone
              improves call realism but the AI agent works with the default
              voice if no sample is recorded. */}
          <div className="border-t border-gray-200 pt-6">
            <h3 className="text-sm font-semibold text-gray-700 mb-1">Voice Sample for IRS PPS Calls <span className="text-xs font-normal text-gray-500">(Optional — skip if your mic isn&apos;t available)</span></h3>
            <p className="text-xs text-gray-500 mb-3">
              When recorded, the AI agent uses a clone of your voice on PPS calls so the IRS rep hears you, not a stock TTS voice.
              Skip this if your microphone is blocked or you&apos;d rather record later — you can still save the rest of your profile and take assignments.
            </p>
            <VoiceRecorder
              existingUrl={profile.voice_sample_url || null}
              onUploaded={(url) => setProfile((prev) => ({ ...prev, voice_sample_url: url }))}
            />
          </div>

          {/* Status */}
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg">
              {error}
            </div>
          )}

          {success && (
            <div className="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded-lg">
              ✓ Profile saved successfully! Redirecting to your queue...
            </div>
          )}

          <div className="flex items-center justify-between pt-4">
            <button
              type="button"
              onClick={() => router.push('/expert')}
              className="text-sm text-gray-500 hover:text-gray-700"
            >
              ← Back to Queue
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-6 py-2.5 bg-indigo-600 text-white rounded-lg font-semibold text-sm hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving...' : 'Save Profile'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
