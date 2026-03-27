'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function SignupPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [title, setTitle] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyWebsite, setCompanyWebsite] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
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

    setIsLoading(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullName, title, companyName, companyWebsite, email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.details || data.error || 'Signup failed');
      }

      router.push('/login?signup=success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsLoading(false);
    }
  };

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
              {isLoading ? 'Creating Account...' : 'Create Account'}
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
