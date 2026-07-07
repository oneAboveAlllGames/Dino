// lib/supabaseClient.ts
//
// Single shared Supabase client. Requires two env vars set in your Vercel
// project (Settings -> Environment Variables) and locally in a .env.local
// file that is NOT committed to git:
//   NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
//   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-public-key
//
// Both are safe to expose client-side (that's what NEXT_PUBLIC_ means) —
// the anon key is meant to be public and is restricted by Row Level
// Security policies on the database side, not by secrecy.

import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

if (!supabaseUrl || !supabaseAnonKey) {
  // Fails loudly at build/runtime rather than silently breaking realtime
  // connections later, which is much harder to debug.
  console.error(
    "Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY."
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
