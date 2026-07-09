// lib/endless.ts
//
// Endless mode's score persistence: a personal best stored locally
// (per-browser, via localStorage — instant, no network needed), plus every
// completed run submitted to a global `endless_scores` table so the top 10
// all-time scores can be shown to everyone.

import { supabase } from "./supabaseClient";

const LOCAL_HIGH_SCORE_KEY = "dino_endless_high_score";

export function getLocalHighScore(): number {
  if (typeof window === "undefined") return 0;
  const raw = localStorage.getItem(LOCAL_HIGH_SCORE_KEY);
  return raw ? parseFloat(raw) : 0;
}

// Returns true if this run set a new local personal best.
export function saveLocalHighScoreIfBetter(score: number): boolean {
  if (typeof window === "undefined") return false;
  const current = getLocalHighScore();
  if (score > current) {
    localStorage.setItem(LOCAL_HIGH_SCORE_KEY, String(score));
    return true;
  }
  return false;
}

export interface EndlessScore {
  id: string;
  player_name: string;
  score: number;
  created_at: string;
}

export async function submitEndlessScore(playerName: string, score: number): Promise<void> {
  const { error } = await supabase
    .from("endless_scores")
    .insert({ player_name: playerName, score });
  if (error) throw error;
}

export async function fetchTopEndlessScores(limit = 10): Promise<EndlessScore[]> {
  const { data, error } = await supabase
    .from("endless_scores")
    .select("id, player_name, score, created_at")
    .order("score", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as EndlessScore[];
}