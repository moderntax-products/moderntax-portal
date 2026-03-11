'use client';

import { useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase';

interface MfaSetupProps {
  initialState: 'unenrolled' | 'enrolled';
  factorId?: string;
}

export function MfaSetup({ initialState, factorId }: MfaSetupProps) {
  const [step, setStep] = useState<'idle' | 'enrolling' | 'verifying' | 'success' | 'unenrolling'>(
    initialState === 'enrolled' ? 'idle' : 'idle'
  );
  const [qrCode, setQrCode] = useState<string>('');
  const [secret, setSecret] = useState<string>('');
  const [newFactorId, setNewFactorId] = useState<string>('');
  const [verifyCode, setVerifyCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [enrolled, setEnrolled] = useState(initialState === 'enrolled');

  const supabase = createClient();

  // Step 1: Enroll — generate QR code
  const handleEnroll = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data, error: enrollError } = await supabase.auth.mfa.enroll({
        factorType: 'totp',
        friendlyName: 'Authenticator App',
      });

      if (enrollError) {
        setError(enrollError.message);
        return;
      }

      if (data) {
        setQrCode(data.totp.qr_code);
        setSecret(data.totp.secret);
        setNewFactorId(data.id);
        setStep('enrolling');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start enrollment');
    } finally {
      setLoading(false);
    }
  }, [supabase]);

  // Step 2: Verify — confirm TOTP code
  const handleVerify = useCallback(async () => {
    if (verifyCode.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: newFactorId,
      });

      if (challengeError) {
        setError(challengeError.message);
        return;
      }

      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: newFactorId,
        challengeId: challenge.id,
        code: verifyCode,
      });

      if (verifyError) {
        setError('Invalid verification code. Please try again.');
        setVerifyCode('');
        return;
      }

      setStep('success');
      setEnrolled(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setLoading(false);
    }
  }, [supabase, newFactorId, verifyCode]);

  // Unenroll MFA
  const handleUnenroll = useCallback(async () => {
    if (!factorId) return;
    setLoading(true);
    setError('');
    try {
      const { error: unenrollError } = await supabase.auth.mfa.unenroll({
        factorId,
      });

      if (unenrollError) {
        setError(unenrollError.message);
        return;
      }

      setEnrolled(false);
      setStep('idle');
      // Refresh the page to update server-side MFA status
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable MFA');
    } finally {
      setLoading(false);
    }
  }, [supabase, factorId]);

  // Cancel enrollment
  const handleCancel = useCallback(async () => {
    if (newFactorId) {
      // Clean up the unverified factor
      await supabase.auth.mfa.unenroll({ factorId: newFactorId });
    }
    setStep('idle');
    setQrCode('');
    setSecret('');
    setNewFactorId('');
    setVerifyCode('');
    setError('');
  }, [supabase, newFactorId]);

  // --- ENROLLED STATE: Show unenroll option ---
  if (enrolled && step !== 'success') {
    return (
      <div>
        {step === 'unenrolling' ? (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 space-y-3">
            <p className="text-sm font-semibold text-red-800">
              Are you sure you want to disable MFA?
            </p>
            <p className="text-xs text-red-600">
              Disabling MFA reduces your account security. SOC 2 compliance requires MFA for all users.
            </p>
            {error && (
              <div className="bg-red-100 border border-red-300 text-red-700 text-sm px-3 py-2 rounded">
                {error}
              </div>
            )}
            <div className="flex gap-3">
              <button
                onClick={handleUnenroll}
                disabled={loading}
                className="px-4 py-2 text-sm font-semibold bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {loading ? 'Disabling...' : 'Yes, Disable MFA'}
              </button>
              <button
                onClick={() => { setStep('idle'); setError(''); }}
                className="px-4 py-2 text-sm font-semibold text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setStep('unenrolling')}
            className="text-sm text-red-600 hover:text-red-800 underline font-medium"
          >
            Disable MFA
          </button>
        )}
      </div>
    );
  }

  // --- SUCCESS STATE ---
  if (step === 'success') {
    return (
      <div className="bg-green-50 border border-green-200 rounded-lg p-6 text-center space-y-3">
        <div className="mx-auto w-12 h-12 bg-green-100 rounded-full flex items-center justify-center">
          <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-lg font-semibold text-green-800">MFA Enabled Successfully!</p>
        <p className="text-sm text-green-600">
          Your account is now protected with multi-factor authentication.
        </p>
        <button
          onClick={() => window.location.reload()}
          className="mt-2 px-6 py-2 bg-mt-green text-white rounded-lg font-semibold hover:bg-opacity-90 transition-colors"
        >
          Done
        </button>
      </div>
    );
  }

  // --- ENROLLING STATE: Show QR code ---
  if (step === 'enrolling') {
    return (
      <div className="space-y-6">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-blue-800 mb-3">Step 1: Scan QR Code</h3>
          <p className="text-xs text-blue-600 mb-4">
            Open your authenticator app and scan the QR code below. If you can&apos;t scan, enter the secret key manually.
          </p>

          <div className="flex flex-col items-center gap-4">
            {/* QR Code */}
            {qrCode && (
              <div className="bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
                <img src={qrCode} alt="MFA QR Code" className="w-48 h-48" />
              </div>
            )}

            {/* Manual Secret */}
            <details className="w-full">
              <summary className="text-xs text-blue-600 cursor-pointer hover:text-blue-800 font-medium">
                Can&apos;t scan? Enter code manually
              </summary>
              <div className="mt-2 bg-white rounded-lg border border-gray-200 p-3">
                <p className="text-xs text-gray-500 mb-1">Secret Key:</p>
                <code className="text-sm font-mono text-mt-dark break-all select-all bg-gray-50 px-2 py-1 rounded block">
                  {secret}
                </code>
              </div>
            </details>
          </div>
        </div>

        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">Step 2: Enter Verification Code</h3>
          <p className="text-xs text-gray-500 mb-3">
            Enter the 6-digit code shown in your authenticator app to confirm setup.
          </p>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded mb-3">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={verifyCode}
              onChange={(e) => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                setVerifyCode(val);
              }}
              placeholder="000000"
              className="flex-1 px-4 py-3 text-center text-2xl font-mono tracking-[0.5em] border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && verifyCode.length === 6) {
                  handleVerify();
                }
              }}
            />
          </div>

          <div className="flex gap-3 mt-4">
            <button
              onClick={handleVerify}
              disabled={loading || verifyCode.length !== 6}
              className="flex-1 py-3 bg-mt-green text-white rounded-lg font-semibold hover:bg-opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? 'Verifying...' : 'Verify & Enable MFA'}
            </button>
            <button
              onClick={handleCancel}
              className="px-6 py-3 text-gray-600 border border-gray-300 rounded-lg font-semibold hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- IDLE/UNENROLLED STATE: Show enroll button ---
  return (
    <div>
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded mb-4">
          {error}
        </div>
      )}
      <button
        onClick={handleEnroll}
        disabled={loading}
        className="w-full sm:w-auto px-6 py-3 bg-mt-green text-white rounded-lg font-semibold hover:bg-opacity-90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
      >
        {loading ? (
          <>
            <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            Setting up...
          </>
        ) : (
          <>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Set Up MFA
          </>
        )}
      </button>
    </div>
  );
}
