// lib/rooms.ts
//
// Room logic for N-player races. Live room membership (who's in the
// waiting room, who's ready) is NOT stored in the database — it's tracked
// entirely via Supabase Realtime Presence on a channel scoped to the room
// code. This avoids a write to the database every time someone joins,
// toggles ready, etc., and Presence updates are near-instant compared to
// database round trips. The database is only used for:
//   1. Creating the room (so a code can be looked up / validated)
//   2. Storing each player's final race result (the one place where we
//      genuinely need a single, durable source of truth all clients agree
//      on, since Broadcast messages can be dropped)

import { supabase } from "./supabaseClient";

export interface GameRoom {
  id: string;
  code: string;
  seed: number;
  duration_ms: number;
  status: "waiting" | "active" | "finished";
  host_id: string;
  created_at: string;
}

export interface RaceResult {
  player_id: string;
  player_name: string;
  distance: number;
}

const PLAYER_ID_KEY = "dino_player_id";
const PLAYER_NAME_KEY = "dino_player_name";

export function getPlayerId(): string {
  if (typeof window === "undefined") return "";
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

export function getPlayerName(): string {
  if (typeof window === "undefined") return "Player";
  return localStorage.getItem(PLAYER_NAME_KEY) || "Player";
}

export function setPlayerName(name: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(PLAYER_NAME_KEY, name.trim().slice(0, 16) || "Player");
}

function generateRoomCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function createRoom(durationMs: number): Promise<GameRoom> {
  const hostId = getPlayerId();
  const code = generateRoomCode();
  const seed = Math.floor(Math.random() * 2 ** 31);

  const { data, error } = await supabase
    .from("game_rooms")
    .insert({ code, seed, duration_ms: durationMs, status: "waiting", host_id: hostId })
    .select()
    .single();

  if (error) throw error;
  return data as GameRoom;
}

// New room for a rematch — same duration, fresh seed/code, same host.
export async function createRematchRoom(durationMs: number): Promise<GameRoom> {
  return createRoom(durationMs);
}

export async function getRoomByCode(code: string): Promise<GameRoom> {
  const { data, error } = await supabase
    .from("game_rooms")
    .select()
    .eq("code", code.toUpperCase())
    .single();
  if (error || !data) throw new Error("Room not found");
  return data as GameRoom;
}

export async function reportRaceResult(
  roomId: string,
  playerId: string,
  playerName: string,
  distance: number
): Promise<void> {
  const { error } = await supabase
    .from("race_results")
    .upsert(
      { room_id: roomId, player_id: playerId, player_name: playerName, distance },
      { onConflict: "room_id,player_id" }
    );
  if (error) throw error;
}

export async function fetchRaceResults(roomId: string): Promise<RaceResult[]> {
  const { data, error } = await supabase
    .from("race_results")
    .select("player_id, player_name, distance")
    .eq("room_id", roomId);
  if (error) throw error;
  return (data ?? []) as RaceResult[];
}
