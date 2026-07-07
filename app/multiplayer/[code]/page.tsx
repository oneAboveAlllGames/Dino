"use client";

// app/multiplayer/[code]/page.tsx
//
// The actual race. Two players in the same room.
//
// Speed notes:
//  - Room "join" detection uses Realtime Presence + Broadcast on the race
//    channel itself, NOT Postgres change events. postgres_changes has real
//    replication lag (often 1-3s+ on the free tier) because it waits on
//    the database's write-ahead log; Presence/Broadcast are peer-to-peer
//    over the same websocket and are near-instant. We still persist to the
//    game_rooms table for reconnect/history purposes, but the UI never
//    blocks on that round trip.
//  - The "start" timestamp is agreed by broadcast (host picks it and tells
//    the joiner) rather than by both clients separately reading the DB row,
//    for the same reason.
//  - Finish detection re-sends the local "finish" broadcast every second
//    for a while after finishing. This covers the case where the opponent's
//    browser tab was backgrounded — background tabs get their
//    requestAnimationFrame loop throttled by the browser (often to ~1fps
//    or less), which can genuinely delay their own finish detection. There
//    isn't a way to fully bypass browser tab throttling from here, but
//    resending reduces the chance of a single dropped message adding delay
//    on top of that.

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import DinoCanvas from "../../../components/DinoCanvas";
import { supabase } from "../../../lib/supabaseClient";
import { GameRoom, getPlayerId, getPlayerName, joinRoom } from "../../../lib/rooms";
import { RemotePlayerState } from "../../../lib/types";

export default function RacePage() {
  const params = useParams();
  const code = (params?.code as string)?.toUpperCase();

  const [room, setRoom] = useState<GameRoom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remoteState, setRemoteState] = useState<RemotePlayerState | null>(null);
  const [myResult, setMyResult] = useState<number | null>(null);
  const [opponentResult, setOpponentResult] = useState<number | null>(null);
  const [opponentPresent, setOpponentPresent] = useState(false);
  const [raceStartAt, setRaceStartAt] = useState<number | null>(null);

  const playerIdRef = useRef<string>("");
  const playerNameRef = useRef<string>("Player");
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const isHostRef = useRef(false);
  const finishTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --- Load / persist room membership in the background (not UI-blocking) ---
  useEffect(() => {
    if (!code) return;
    playerIdRef.current = getPlayerId();
    playerNameRef.current = getPlayerName();

    joinRoom(code)
      .then((r) => {
        setRoom(r);
        isHostRef.current = r.player1_id === playerIdRef.current;
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load room"));
  }, [code]);

  // --- Realtime channel: presence for instant join detection, broadcast
  //     for start-sync, in-race state, and finish results ---
  useEffect(() => {
    if (!code) return;

    const channel = supabase.channel(`race-${code}`, {
      config: { broadcast: { self: false }, presence: { key: getPlayerId() } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        const otherPresent = Object.keys(state).some((k) => k !== playerIdRef.current);
        setOpponentPresent(otherPresent);

        // Host decides the shared start time as soon as both are present,
        // and broadcasts it — much faster than waiting for a DB round trip
        // both clients would otherwise poll for.
        if (otherPresent && isHostRef.current && !raceStartAt) {
          const startedAt = Date.now() + 1200; // short buffer so both clients are ready
          channel.send({
            type: "broadcast",
            event: "start",
            payload: { startedAt },
          });
          setRaceStartAt(startedAt);
        }
      })
      .on("broadcast", { event: "start" }, ({ payload }) => {
        setRaceStartAt(payload.startedAt);
      })
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
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ joinedAt: Date.now() });
        }
      });

    channelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
      if (finishTimerRef.current) clearInterval(finishTimerRef.current);
    };
  }, [code]);

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

    const sendFinish = () => {
      channelRef.current?.send({
        type: "broadcast",
        event: "finish",
        payload: { playerId: playerIdRef.current, distance: finalDistance },
      });
    };

    sendFinish();
    // Resend every second for up to 15s in case the first send was dropped
    // or the opponent's tab is backgrounded/throttled and slow to receive.
    let attempts = 0;
    finishTimerRef.current = setInterval(() => {
      attempts += 1;
      sendFinish();
      if (attempts >= 15) {
        if (finishTimerRef.current) clearInterval(finishTimerRef.current);
      }
    }, 1000);
  };

  // Stop resending once we've heard back from the opponent.
  useEffect(() => {
    if (opponentResult !== null && finishTimerRef.current) {
      clearInterval(finishTimerRef.current);
    }
  }, [opponentResult]);

  if (error) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <p style={{ color: "#cc3333" }}>{error}</p>
      </main>
    );
  }

  if (!code) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <p>Loading room…</p>
      </main>
    );
  }

  if (!raceStartAt) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <h1>Waiting for opponent…</h1>
        <p>
          You're in as <strong>{playerNameRef.current}</strong>.
        </p>
        <p>
          Share this code: <strong style={{ fontSize: 24, letterSpacing: 2 }}>{code}</strong>
        </p>
        {opponentPresent && <p style={{ color: "#0077cc" }}>Opponent connected — starting…</p>}
      </main>
    );
  }

  const bothFinished = myResult !== null && opponentResult !== null;
  const iWon = bothFinished && myResult! > opponentResult!;
  const tied = bothFinished && myResult === opponentResult;

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Race — Room {code}</h1>

      <DinoCanvas
        seed={room?.seed ?? 1}
        durationMs={room?.duration_ms ?? 120_000}
        raceStartAt={raceStartAt}
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
            <p style={{ color: "#666" }}>
              Waiting for opponent to finish… (if their tab is in the background, this can take a bit — ask them to switch back to it)
            </p>
          )}
          {bothFinished && (
            <h2>{tied ? "It's a tie!" : iWon ? "You win! 🎉" : "Opponent wins"}</h2>
          )}
        </div>
      )}
    </main>
  );
}
