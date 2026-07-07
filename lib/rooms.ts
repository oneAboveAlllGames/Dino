// lib/rooms.ts
//
// Room/lobby logic backed by a `game_rooms` table in Supabase. See
// supabase-schema.sql for the table definition and RLS policies to run
// once in your Supabase project's SQL editor.

import { supabase } from "./supabaseClient";

export interface GameRoom {
  id: string;
  code: string;
  seed: number;
  duration_ms: number;
  status: "waiting" | "active" | "finished";
  player1_id: string;
  player2_id: string | null;
  started_at: string | null;
  created_at: string;
}

const PLAYER_ID_KEY = "dino_player_id";
const PLAYER_NAME_KEY = "dino_player_name";

export function getPlayerName(): string {
  if (typeof window === "undefined") return "Player";
  return localStorage.getItem(PLAYER_NAME_KEY) || "Player";
}

export function setPlayerName(name: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(PLAYER_NAME_KEY, name.trim().slice(0, 16) || "Player");
}

// Each browser gets a persistent random id, stored in localStorage, so a
// player reconnecting (e.g. after a refresh) is recognized as the same
// player rather than treated as a new one.
export function getPlayerId(): string {
  if (typeof window === "undefined") return "";
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

function generateRoomCode(): string {
  // 5 uppercase letters/digits, excluding easily-confused characters
  // (0/O, 1/I) so codes are easy to read aloud or type on mobile.
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export async function createRoom(durationMs: number): Promise<GameRoom> {
  const playerId = getPlayerId();
  const code = generateRoomCode();
  const seed = Math.floor(Math.random() * 2 ** 31);

  const { data, error } = await supabase
    .from("game_rooms")
    .insert({
      code,
      seed,
      duration_ms: durationMs,
      status: "waiting",
      player1_id: playerId,
    })
    .select()
    .single();

  if (error) throw error;
  return data as GameRoom;
}

export async function joinRoom(code: string): Promise<GameRoom> {
  const playerId = getPlayerId();

  const { data: room, error: fetchError } = await supabase
    .from("game_rooms")
    .select()
    .eq("code", code.toUpperCase())
    .single();

  if (fetchError || !room) throw new Error("Room not found");

  // Already the host, or already the joined player (reconnect) — just
  // return the room as-is.
  if (room.player1_id === playerId || room.player2_id === playerId) {
    return room as GameRoom;
  }

  if (room.player2_id) {
    throw new Error("Room is full");
  }

  // Race-condition-safe join: only succeeds if player2_id is still null
  // at the moment of the update, so two people can't both claim slot 2.
  const { data, error } = await supabase
    .from("game_rooms")
    .update({ player2_id: playerId, status: "active", started_at: new Date().toISOString() })
    .eq("id", room.id)
    .is("player2_id", null)
    .select()
    .single();

  if (error || !data) throw new Error("Room was just filled by someone else — try another code");
  return data as GameRoom;
}

export function subscribeToRoom(
  roomId: string,
  onChange: (room: GameRoom) => void
) {
  const channel = supabase
    .channel(`room-changes-${roomId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "game_rooms", filter: `id=eq.${roomId}` },
      (payload) => onChange(payload.new as GameRoom)
    )
    .subscribe();

  return () => {
    supabase.removeChannel(channel);
  };
}
