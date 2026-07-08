"use client";

// app/multiplayer/page.tsx
//
// Lobby: create a room (pick round length) or join one by code. Joining no
// longer writes to the database at all — room membership is entirely
// Presence-based once you land on the room page, so "joining" here is just
// validating the code exists before navigating.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createRoom, getRoomByCode, getPlayerName, setPlayerName } from "../../lib/rooms";

const DURATION_OPTIONS = [
  { label: "1.5 min", ms: 90_000 },
  { label: "2 min", ms: 120_000 },
  { label: "3 min", ms: 180_000 },
];

export default function MultiplayerLobby() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const saved = getPlayerName();
    if (saved !== "Player") setName(saved);
  }, []);

  const ensureName = () => {
    if (!name.trim()) {
      setError("Enter a name first");
      return false;
    }
    setPlayerName(name);
    return true;
  };

  const handleCreate = async (durationMs: number) => {
    setError(null);
    if (!ensureName()) return;
    setCreating(true);
    try {
      const room = await createRoom(durationMs);
      router.push(`/multiplayer/${room.code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create room");
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    if (!joinCode.trim()) return;
    setError(null);
    if (!ensureName()) return;
    setJoining(true);
    try {
      await getRoomByCode(joinCode.trim()); // just validates it exists
      router.push(`/multiplayer/${joinCode.trim().toUpperCase()}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Room not found");
      setJoining(false);
    }
  };

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 480 }}>
      <h1>Dino Multiplayer</h1>

      <section style={{ marginTop: 16 }}>
        <label style={{ fontSize: 14, color: "#666" }}>Your name</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Rowland"
          maxLength={16}
          style={{
            display: "block",
            width: "100%",
            padding: "10px 12px",
            fontSize: 15,
            borderRadius: 8,
            border: "1px solid #333",
            marginTop: 4,
          }}
        />
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 18 }}>Create a race</h2>
        <p style={{ color: "#666", fontSize: 14 }}>Pick a round length:</p>
        <div style={{ display: "flex", gap: 8 }}>
          {DURATION_OPTIONS.map((opt) => (
            <button
              key={opt.ms}
              disabled={creating}
              onClick={() => handleCreate(opt.ms)}
              style={{
                flex: 1,
                padding: "12px 0",
                borderRadius: 8,
                border: "1px solid #333",
                background: "#fff",
                fontSize: 15,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p style={{ color: "#999", fontSize: 12, marginTop: 6 }}>
          You'll land in a waiting room where anyone can join with the code — start whenever everyone's ready.
        </p>
      </section>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18 }}>Join a race</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="ROOM CODE"
            maxLength={5}
            style={{
              flex: 1,
              padding: "12px",
              fontSize: 16,
              borderRadius: 8,
              border: "1px solid #333",
              letterSpacing: 2,
              textTransform: "uppercase",
            }}
          />
          <button
            disabled={joining || !joinCode.trim()}
            onClick={handleJoin}
            style={{
              padding: "12px 20px",
              borderRadius: 8,
              border: "1px solid #333",
              background: "#333",
              color: "#fff",
              fontSize: 15,
            }}
          >
            Join
          </button>
        </div>
      </section>

      {error && (
        <p style={{ color: "#cc3333", marginTop: 16, fontSize: 14 }}>{error}</p>
      )}
    </main>
  );
}
