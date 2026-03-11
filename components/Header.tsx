'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase';
import type { Profile } from '@/lib/types';

interface HeaderProps {
  clientName?: string;
}

export function Header({ clientName }: HeaderProps) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [isExpert, setIsExpert] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const supabase = createClient();

  useEffect(() => {
    const fetchProfile = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          setIsLoading(false);
          return;
        }

        const { data, error } = await supabase
          .from('profiles')
          .select()
          .eq('id', user.id)
          .single() as { data: Profile | null; error: any };

        if (!error && data) {
          setProfile(data);
          setIsAdmin(data.role === 'admin');
          setIsExpert(data.role === 'expert');
        }
      } catch (error) {
        console.error('Failed to fetch profile:', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchProfile();
  }, [supabase]);

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
    window.location.href = '/';
  }, [supabase]);

  const ModernTaxLogo = () => (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z"
        fill="#00C48C"
      />
    </svg>
  );

  return (
    <header className="bg-gradient-to-r from-slate-900 via-slate-900 to-slate-800 border-b-4 border-emerald-500 shadow-lg">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          {/* Logo and Brand */}
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
              <ModernTaxLogo />
              <span className="text-white font-bold text-lg">ModernTax</span>
            </Link>
            {clientName && (
              <div className="hidden sm:flex items-center pl-4 border-l border-slate-600">
                <span className="text-slate-300 text-sm">{clientName}</span>
              </div>
            )}
          </div>

          {/* Navigation */}
          <nav className="hidden md:flex items-center gap-8">
            {isExpert ? (
              <Link
                href="/expert"
                className="text-slate-200 hover:text-emerald-400 transition-colors text-sm font-medium"
              >
                My Queue
              </Link>
            ) : (
              <>
                <Link
                  href="/dashboard"
                  className="text-slate-200 hover:text-emerald-400 transition-colors text-sm font-medium"
                >
                  Dashboard
                </Link>
                <Link
                  href="/request/new"
                  className="text-slate-200 hover:text-emerald-400 transition-colors text-sm font-medium"
                >
                  New Request
                </Link>
              </>
            )}
            {isAdmin && (
              <Link
                href="/admin"
                className="text-slate-200 hover:text-emerald-400 transition-colors text-sm font-medium"
              >
                Admin
              </Link>
            )}
          </nav>

          {/* User Info and Sign Out */}
          <div className="flex items-center gap-4">
            {!isLoading && profile && (
              <div className="hidden sm:flex flex-col items-end">
                <p className="text-white text-sm font-medium">{profile.full_name || 'User'}</p>
                <p className="text-slate-400 text-xs">{profile.email}</p>
              </div>
            )}
            <button
              onClick={handleSignOut}
              className="px-4 py-2 bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Sign Out
            </button>
          </div>
        </div>

        {/* Mobile Navigation */}
        <div className="md:hidden flex justify-center gap-6 pb-4 pt-2 border-t border-slate-700">
          {isExpert ? (
            <Link
              href="/expert"
              className="text-slate-200 hover:text-emerald-400 transition-colors text-sm font-medium"
            >
              My Queue
            </Link>
          ) : (
            <>
              <Link
                href="/dashboard"
                className="text-slate-200 hover:text-emerald-400 transition-colors text-sm font-medium"
              >
                Dashboard
              </Link>
              <Link
                href="/request/new"
                className="text-slate-200 hover:text-emerald-400 transition-colors text-sm font-medium"
              >
                New Request
              </Link>
            </>
          )}
          {isAdmin && (
            <Link
              href="/admin"
              className="text-slate-200 hover:text-emerald-400 transition-colors text-sm font-medium"
            >
              Admin
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
