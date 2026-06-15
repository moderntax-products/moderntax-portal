'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';

export default function SignupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isPendingReview = searchParams.get('status') === 'pending-review';
  const [fullName, setFullName] = useState('');
  const [title, setTitle] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyWebsite, setCompanyWebsite] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // Lead qualification — required so we can vet before authorizing access
  const [referralSource, setReferralSource] = useState('');
  const [useCase, setUseCase] = useState<'sba' | 'employment' | 'insurance' | 'other' | ''>('');
  const [useCaseOther, setUseCaseOther] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Domain match validation
  const emailDomain = email.includes('@') ? email.split('@')[1]?.toLowerCase() : '';
  const websiteDomain = companyWebsite
    ? companyWebsite.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
    : '';
  const domainsMatch = emailDomain && websiteDomain && emailDomain === websiteDomain;
  const showDomainError = emailDomain && websiteDomain && !domainsMatch;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!fullName.trim()) { setError('Full name is required'); return; }
    if (!title.trim()) { setError('Title is required'); return; }
    if (!companyName.trim()) { setError('Company name is required'); return; }
    if (!companyWebsite.trim()) { setError('Company website is required'); return; }
    if (!email.trim()) { setError('Email is required'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    if (password !== confirmPassword) { setError('Passwords do not match'); return; }
    if (!domainsMatch) { setError('Email domain must match your company website'); return; }
    if (!useCase) { setError('Please select your primary use case'); return; }
    if (useCase === 'other' && !useCaseOther.trim()) { setError('Please describe your use case'); return; }
    if (!referralSource.trim()) { setError('Please tell us how you heard about us'); return; }

    setIsLoading(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName, title, companyName, companyWebsite, email, password,
          referralSource: referralSource.trim(),
          useCase,
          useCaseOther: useCase === 'other' ? useCaseOther.trim() : null,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.details || data.error || 'Signup failed');
      }

      // Account created in 'pending' state — gate redirect to a friendly
      // "we got your request, looking forward to onboarding you" page
      // instead of the login screen, so they don't immediately try to
      // sign in and get bounced.
      router.push('/signup?status=pending-review');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

  // Friendly post-signup state — account is created but pending admin
  // review. Shown instead of the form when ?status=pending-review.
  if (isPendingReview) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-mt-dark via-mt-navy to-mt-dark flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white tracking-tight">
              Modern<span className="text-mt-green">Tax</span>
            </h1>
          </div>
          <div className="bg-white rounded-2xl shadow-2xl p-8 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-emerald-100 flex items-center justify-center">
              <svg className="w-8 h-8 text-mt-green" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-mt-dark mb-2">Thanks — one quick step to activate</h2>
            <p className="text-sm text-gray-600 mb-5">
              To approve your account, we do a short intro call so we can set you up correctly for your use case (SBA, employment verification, insurance, or other). <strong className="text-mt-dark">Book your demo below</strong> — we approve and send login access right after.
            </p>
            <a
              href="https://meetings.hubspot.com/matt-moderntax/moderntax-intro"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-2 w-full bg-mt-green text-white font-semibold rounded-lg px-6 py-3 hover:bg-emerald-600 transition-colors mb-4"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Book your demo →
            </a>
            <p className="text-xs text-gray-500 mb-6">
              Questions? Email <a href="mailto:matt@moderntax.io" className="text-mt-green hover:underline">matt@moderntax.io</a> — Matthew Parker, founder.
            </p>
            <Link href="/" className="text-sm text-mt-green font-semibold hover:underline">
              Back to ModernTax →
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-mt-dark via-mt-navy to-mt-dark flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white tracking-tight">
            Modern<span className="text-mt-green">Tax</span>
          </h1>
          <p className="text-gray-400 mt-2">Create your account</p>
        </div>

        {/* Form Card */}
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          <h2 className="text-xl font-bold text-mt-dark mb-6">Get Started</h2>
          <p className="text-xs text-gray-500 mb-4">
            We review every new account before granting access — usually within one business day. This keeps the platform secure for our existing customers and lets us tailor your onboarding to your specific use case.
          </p>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-red-700 text-sm">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Full Name</label>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Jane Smith"
                required
                disabled={isLoading}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Credit Manager, VP Lending, etc."
                required
                disabled={isLoading}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Company Name</label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                placeholder="Acme Lending Corp"
                required
                disabled={isLoading}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Company Website</label>
              <input
                type="text"
                value={companyWebsite}
                onChange={(e) => setCompanyWebsite(e.target.value)}
                placeholder="acmelending.com"
                required
                disabled={isLoading}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 text-sm"
              />
              <p className="text-xs text-gray-400 mt-1">Your business email must match this domain</p>
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Business Email</label>
              <div className="relative">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="jane@acmelending.com"
                  required
                  disabled={isLoading}
                  className={`w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 text-sm ${
                    showDomainError ? 'border-red-300 bg-red-50' : domainsMatch ? 'border-green-300 bg-green-50' : 'border-gray-300'
                  }`}
                />
                {domainsMatch && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    <svg className="w-5 h-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                  </div>
                )}
              </div>
              {showDomainError && (
                <p className="text-xs text-red-600 mt-1">
                  Email domain (@{emailDomain}) does not match website ({websiteDomain})
                </p>
              )}
            </div>

            {/* Use case — required so we can route the right onboarding */}
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">
                Primary use case <span className="text-red-500">*</span>
              </label>
              <select
                value={useCase}
                onChange={(e) => setUseCase(e.target.value as typeof useCase)}
                required
                disabled={isLoading}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 text-sm bg-white"
              >
                <option value="">Select a use case...</option>
                <option value="sba">SBA loan underwriting (transcript verification)</option>
                <option value="employment">Employment / income verification</option>
                <option value="insurance">Insurance underwriting</option>
                <option value="other">Other (please describe)</option>
              </select>
              <p className="text-xs text-gray-400 mt-1">Tells us how to set up your account — pricing, integrations, and starter templates differ per use case.</p>
            </div>

            {useCase === 'other' && (
              <div>
                <label className="block text-sm font-semibold text-gray-700 mb-1">
                  Describe your use case <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={useCaseOther}
                  onChange={(e) => setUseCaseOther(e.target.value)}
                  placeholder="e.g., M&A diligence, tax prep firm, etc."
                  required
                  maxLength={200}
                  disabled={isLoading}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 text-sm"
                />
              </div>
            )}

            {/* Referral source */}
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">
                How did you hear about us? <span className="text-red-500">*</span>
              </label>
              <select
                value={referralSource}
                onChange={(e) => setReferralSource(e.target.value)}
                required
                disabled={isLoading}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 text-sm bg-white"
              >
                <option value="">Select...</option>
                <option value="search">Search engine (Google, etc.)</option>
                <option value="referral">Referred by a colleague or friend</option>
                <option value="linkedin">LinkedIn or social media</option>
                <option value="conference">Conference / industry event</option>
                <option value="email">Email outreach from ModernTax</option>
                <option value="competitor">Switching from another transcript service</option>
                <option value="other">Other</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Min. 8 characters"
                required
                minLength={8}
                disabled={isLoading}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 text-sm"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-1">Confirm Password</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm password"
                required
                disabled={isLoading}
                className={`w-full px-4 py-3 border rounded-lg focus:outline-none focus:ring-2 focus:ring-mt-green focus:border-transparent disabled:opacity-50 text-sm ${
                  confirmPassword && password !== confirmPassword ? 'border-red-300' : 'border-gray-300'
                }`}
              />
              {confirmPassword && password !== confirmPassword && (
                <p className="text-xs text-red-600 mt-1">Passwords do not match</p>
              )}
            </div>

            <button
              type="submit"
              disabled={isLoading || !domainsMatch}
              className="w-full bg-mt-green text-white py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-2"
            >
              {isLoading ? 'Submitting...' : 'Submit for Review'}
            </button>
          </form>

          <p className="text-center text-sm text-gray-600 mt-6">
            Already have an account?{' '}
            <Link href="/login" className="text-mt-green font-semibold hover:underline">
              Sign in
            </Link>
          </p>
        </div>

        {/* SOC 2 Badge */}
        <div className="text-center mt-6">
          <p className="text-gray-500 text-xs">
            SOC 2 Compliant &bull; 256-bit Encryption &bull; Same-Day Turnaround
          </p>
        </div>
      </div>
    </div>
  );
}
