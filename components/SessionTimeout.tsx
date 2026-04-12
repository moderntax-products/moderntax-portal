'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase';

/**
 * SOC 2 Compliant Session Timeout Component
 * Automatically logs out inactive users after 15 minutes
 * Shows a warning 2 minutes before timeout
 */

const TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes
const WARNING_MS = 2 * 60 * 1000; // Show warning 2 minutes before timeout

export function SessionTimeout() {
  const [showWarning, setShowWarning] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [hasSession, setHasSession] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const warningRef = useRef<NodeJS.Timeout | null>(null);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const showWarningRef = useRef(false); // Ref to avoid stale closure issues

  const handleLogout = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login?reason=timeout';
  }, []);

  const resetTimers = useCallback(() => {
    // Clear existing timers
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (warningRef.current) clearTimeout(warningRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);

    setShowWarning(false);
    showWarningRef.current = false;

    // Set warning timer
    warningRef.current = setTimeout(() => {
      setShowWarning(true);
      showWarningRef.current = true;
      setSecondsLeft(Math.floor(WARNING_MS / 1000));

      // Start countdown
      countdownRef.current = setInterval(() => {
        setSecondsLeft((prev) => {
          if (prev <= 1) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }, TIMEOUT_MS - WARNING_MS);

    // Set logout timer
    timeoutRef.current = setTimeout(() => {
      handleLogout();
    }, TIMEOUT_MS);
  }, [handleLogout]);

  const handleExtend = useCallback(() => {
    resetTimers();
  }, [resetTimers]);

  // Check if user has an active session — don't render overlay on public pages
  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setHasSession(!!data.session);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setHasSession(!!session);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!hasSession) return; // Don't run timers if no session

    // Activity events to track
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart'];

    const handleActivity = () => {
      // Use ref to check warning state — avoids stale closure bug
      if (!showWarningRef.current) {
        resetTimers();
      }
    };

    // Initial timer setup
    resetTimers();

    // Listen for user activity
    events.forEach((event) => {
      document.addEventListener(event, handleActivity, { passive: true });
    });

    return () => {
      events.forEach((event) => {
        document.removeEventListener(event, handleActivity);
      });
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (warningRef.current) clearTimeout(warningRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [resetTimers, hasSession]);

  if (!showWarning || !hasSession) return null;

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl p-8 max-w-md w-full mx-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-yellow-100 rounded-full">
            <svg className="w-6 h-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-bold text-gray-900">Session Expiring</h3>
        </div>
        <p className="text-gray-600 mb-2">
          For security, your session will expire due to inactivity.
        </p>
        <p className="text-2xl font-bold text-red-600 mb-6">
          {minutes}:{seconds.toString().padStart(2, '0')}
        </p>
        <div className="flex gap-3">
          <button
            onClick={handleExtend}
            className="flex-1 bg-mt-green text-white py-3 rounded-lg font-semibold hover:bg-opacity-90 transition-colors"
          >
            Stay Logged In
          </button>
          <button
            onClick={handleLogout}
            className="flex-1 py-3 border border-gray-300 rounded-lg font-semibold text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Log Out Now
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-4 text-center">
          SOC 2 Security: Sessions automatically expire after 15 minutes of inactivity.
        </p>
      </div>
    </div>
  );
}
