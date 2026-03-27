import { redirect } from 'next/navigation';
import { createServerComponentClient } from '@/lib/supabase-server';
import Link from 'next/link';
import { LogoutButton } from '@/components/LogoutButton';
import { getClassificationLabel, getClassificationColor } from '@/lib/mask';
import { MfaSetup } from '@/components/MfaSetup';
import { ChangePasswordForm } from '@/components/ChangePasswordForm';

export default async function SecuritySettingsPage() {
  let supabase;
  try {
    supabase = await createServerComponentClient();
  } catch {
    redirect('/login');
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('full_name, email, role')
    .eq('id', user.id)
    .single() as { data: { full_name: string | null; email: string; role: string } | null; error: unknown };

  // Check current MFA status
  const { data: mfaFactors } = await supabase.auth.mfa.listFactors();
  const totpFactors = mfaFactors?.totp || [];
  const hasMfa = totpFactors.length > 0;
  const verifiedFactor = totpFactors.find((f) => f.status === 'verified');

  return (
    <div className="min-h-screen bg-gray-50">
      {/* SOC 2 Data Classification Banner */}
      <div className={`border-b px-4 py-2 text-center text-xs font-semibold tracking-wide ${getClassificationColor('internal')}`}>
        🔒 {getClassificationLabel('internal')}
      </div>

      {/* Header */}
      <div className="bg-white border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex justify-between items-center">
          <div className="flex items-center gap-4">
            <Link href="/" className="text-gray-400 hover:text-gray-600 transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-mt-dark">Security Settings</h1>
              <p className="text-gray-500 text-sm mt-1">{profile?.full_name || user.email}</p>
            </div>
          </div>
          <LogoutButton />
        </div>
      </div>

      {/* Main Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">

        {/* Account Info Card */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-mt-dark mb-4">Account Information</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500 mb-1">Email</p>
              <p className="font-medium text-gray-900">{user.email}</p>
            </div>
            <div>
              <p className="text-gray-500 mb-1">Role</p>
              <p className="font-medium text-gray-900 capitalize">{profile?.role || 'user'}</p>
            </div>
            <div>
              <p className="text-gray-500 mb-1">Last Sign In</p>
              <p className="font-medium text-gray-900">
                {user.last_sign_in_at
                  ? new Date(user.last_sign_in_at).toLocaleString('en-US', {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })
                  : 'N/A'}
              </p>
            </div>
            <div>
              <p className="text-gray-500 mb-1">Account Created</p>
              <p className="font-medium text-gray-900">
                {new Date(user.created_at).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </p>
            </div>
          </div>
        </div>

        {/* Change Password */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-mt-dark mb-2">Change Password</h2>
          <p className="text-sm text-gray-500 mb-4">Update your account password. You will remain logged in after changing it.</p>
          <ChangePasswordForm />
        </div>

        {/* MFA Section */}
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-semibold text-mt-dark">Multi-Factor Authentication (MFA)</h2>
            {hasMfa && verifiedFactor ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-800">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Enabled
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-800">
                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                Not Enabled
              </span>
            )}
          </div>
          <p className="text-sm text-gray-500 mb-6">
            SOC 2 compliance requires multi-factor authentication for all users accessing sensitive tax data.
            Enable TOTP-based MFA using an authenticator app like Google Authenticator, Authy, or 1Password.
          </p>

          {hasMfa && verifiedFactor ? (
            <div className="space-y-4">
              <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <svg className="w-5 h-5 text-green-600 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  <div>
                    <p className="text-sm font-semibold text-green-800">MFA is active on your account</p>
                    <p className="text-xs text-green-600 mt-1">
                      Factor ID: {verifiedFactor.id.slice(0, 8)}... &bull; Type: TOTP &bull; Status: Verified
                    </p>
                  </div>
                </div>
              </div>
              <MfaSetup initialState="enrolled" factorId={verifiedFactor.id} />
            </div>
          ) : (
            <MfaSetup initialState="unenrolled" />
          )}
        </div>

        {/* Session Security Info */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-mt-dark mb-4">Session Security</h2>
          <div className="space-y-3 text-sm text-gray-600">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-mt-green mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <p>Sessions automatically expire after <strong>15 minutes</strong> of inactivity</p>
            </div>
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-mt-green mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <p>All sessions use <strong>encrypted cookies</strong> with HttpOnly, Secure, and SameSite flags</p>
            </div>
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-mt-green mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <p>All access is logged in an <strong>immutable audit trail</strong> for SOC 2 compliance</p>
            </div>
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-mt-green mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <p>Data in transit encrypted via <strong>TLS 1.2+</strong> with HSTS enforcement</p>
            </div>
          </div>
        </div>

        {/* Footer Notice */}
        <div className="text-center text-xs text-gray-400 pb-8">
          <p>Security settings are governed by ModernTax Inc. SOC 2 compliance policies.</p>
          <p className="mt-1">For security concerns, contact <a href="mailto:security@moderntax.io" className="underline">security@moderntax.io</a></p>
        </div>
      </div>
    </div>
  );
}
