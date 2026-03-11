/**
 * Browser-side Supabase Client
 * Use in Client Components ('use client') only
 *
 * For server-side clients, import from '@/lib/supabase-server'
 */

import { createBrowserClient } from '@supabase/ssr';
import type { Database } from './database.types';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Browser-side Supabase client
 * Use in Client Components and browser-only contexts
 */
export function createClient() {
  return createBrowserClient<Database>(supabaseUrl, supabaseAnonKey);
}
