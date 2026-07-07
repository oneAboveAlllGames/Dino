"use client";

// app/multiplayer/[code]/page.tsx
//
// The actual race. Two players in the same room:
//  - Poll/subscribe to the room row to know when player2 has joined and
//    the shared `started_at` timestamp (so both clients' timers agree).
//  - Once active, open a Realtime Broadcast channel scoped to this room
//    and both clients send their local state ~10x/sec and listen for the
//    opponent's.
//  - When a player's local timer runs out, broadcast a "finish" event with
//    their final distance; once both finish (or one does and we've shown
//    the result), display the winner.

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import DinoCanvas from "../../../components/DinoCanvas";
import { supabase } from "../../../lib/supabaseClient";
import { GameRoom, getPlayerId, getPlayerName, joinRoom, subscribeToRoom } from "../../../lib/rooms";
import { RemotePlayerState } from "../../../lib/types";

export default function RacePage() {
  const params = useParams();
  const code = (params?.code as string)?.toUpperCase();

  const [room, setRoom] = useState<GameRoom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remoteState, setRemoteState] = useState<RemotePlayerState | null>(null);
  const [myResult, setMyResult] = useState<number | null>(null);
  const [opponentResult, setOpponentResult] = useState<number | null>(null);

  const playerIdRef = useRef<string>("");
  const playerNameRef = useRef<string>("Player");
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // --- Load / join the room ---
  useEffect(() => {
    if (!code) return;
    playerIdRef.current = getPlayerId();
    playerNameRef.current = getPlayerName();

    joinRoom(code)
      .then(setRoom)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load room"));
  }, [code]);

  // --- Watch for room updates (player2 joining, status changes) ---
  useEffect(() => {
    if (!room?.id) return;
    const unsubscribe = subscribeToRoom(room.id, (updated) => setRoom(updated));
    return unsubscribe;
  }, [room?.id]);

  // --- Realtime broadcast channel for in-race state ---
  useEffect(() => {
    if (!room?.code) return;

    const channel = supabase.channel(`race-${room.code}`, {
      config: { broadcast: { self: false } },
    });

    channel
      .on("broadcast", { event: "state" }, ({ payload }) => {
        if (payload.playerId !== playerIdRef.current) {
          setRemoteState(payload as RemotePlayerState);
        }
      })
      .on("broadcast", { event: "finish" }, ({ payload }) => {
        if (payload.playerId !== playerIdRef.current) {
          setOpponentResult(payload.distance);
        }
      })
      .subscribe();

    channelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
    };
  }, [room?.code]);

  const handleLocalUpdate = (state: {
    distance: number;
    y: number;
    isDucking: boolean;
    isStumbling: boolean;
    isBoosted: boolean;
  }) => {
    channelRef.current?.send({
      type: "broadcast",
      event: "state",
      payload: {
        playerId: playerIdRef.current,
        playerName: playerNameRef.current,
        distance: state.distance,
        y: state.y,
        isDucking: state.isDucking,
        isStumbling: state.isStumbling,
        isBoosted: state.isBoosted,
        finished: false,
        updatedAt: Date.now(),
      },
    });
  };

  const handleFinish = (finalDistance: number) => {
    setMyResult(finalDistance);
    channelRef.current?.send({
      type: "broadcast",
      event: "finish",
      payload: { playerId: playerIdRef.current, distance: finalDistance },
    });
  };

  if (error) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <p style={{ color: "#cc3333" }}>{error}</p>
      </main>
    );
  }

  if (!room) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <p>Loading room…</p>
      </main>
    );
  }

  if (room.status === "waiting") {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <h1>Waiting for opponent…</h1>
        <p>
          You're in as <strong>{playerNameRef.current}</strong>.
        </p>
        <p>
          Share this code: <strong style={{ fontSize: 24, letterSpacing: 2 }}>{room.code}</strong>
        </p>
      </main>
    );
  }

  const bothFinished = myResult !== null && opponentResult !== null;
  const iWon = bothFinished && myResult! > opponentResult!;
  const tied = bothFinished && myResult === opponentResult;

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Race — Room {room.code}</h1>

      <DinoCanvas
        seed={room.seed}
        durationMs={room.duration_ms}
        raceStartAt={room.started_at ? new Date(room.started_at).getTime() : Date.now()}
        remoteState={remoteState}
        localPlayerName={playerNameRef.current}
        onLocalUpdate={handleLocalUpdate}
        onFinish={handleFinish}
      />

      {myResult !== null && (
        <div style={{ marginTop: 16 }}>
          <p>{playerNameRef.current} (you): {Math.floor(myResult)}m</p>
          {opponentResult !== null ? (
            <p>Opponent: {Math.floor(opponentResult)}m</p>
          ) : (
            <p style={{ color: "#666" }}>Waiting for opponent to finish…</p>
          )}
          {bothFinished && (
            <h2>{tied ? "It's a tie!" : iWon ? "You win! 🎉" : "Opponent wins"}</h2>
          )}
        </div>
      )}
    </main>
  );
}
