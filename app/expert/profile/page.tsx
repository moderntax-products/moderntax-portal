'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { useRouter } from 'next/navigation';

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
}

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP',
];

export default function ExpertProfilePage() {
  const router = useRouter();
  const supabase = createClient();
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
  });

  useEffect(() => {
    async function loadProfile() {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        router.push('/login');
        return;
      }

      const { data: profileData } = await supabase
        .from('profiles')
        .select('role, full_name, caf_number, ptin, phone_number, fax_number, address, city, state, zip_code')
        .eq('id', user.id)
        .single();

      if (!profileData || profileData.role !== 'expert') {
        router.push('/');
        return;
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
      });
      setLoading(false);
    }

    loadProfile();
  }, [supabase, router]);

  const handleChange = (field: keyof ExpertProfile, value: string) => {
    setProfile((prev) => ({ ...prev, [field]: value }));
    setError('');
    setSuccess(false);
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

      const { error: updateError } = await supabase
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
        })
        .eq('id', user.id);

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
              placeholder="LaTonya Holmes"
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
              placeholder="8465 Houndstooth Enclave Dr."
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
                placeholder="New Port Richey"
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
                placeholder="34655"
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
                  placeholder="0315-23641R"
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
                  placeholder="P00373519"
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
                  placeholder="727-888-1441"
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
                  placeholder="Optional"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-sm"
                />
              </div>
            </div>
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
