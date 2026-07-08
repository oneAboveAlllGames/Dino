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
import { GameRoom, getPlayerId, getPlayerName, joinRoom, reportFinish, fetchRoom } from "../../../lib/rooms";
import { RemotePlayerState } from "../../../lib/types";

export default function RacePage() {
  const params = useParams();
  const code = (params?.code as string)?.toUpperCase();

  const [room, setRoom] = useState<GameRoom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remoteState, setRemoteState] = useState<RemotePlayerState | null>(null);
  const [myResult, setMyResult] = useState<number | null>(null);
  const [opponentResult, setOpponentResult] = useState<number | null>(null);
  const [opponentName, setOpponentName] = useState<string>("Opponent");
  const [opponentPresent, setOpponentPresent] = useState(false);
  const [raceStartAt, setRaceStartAt] = useState<number | null>(null);
  const remoteStateRef = useRef<RemotePlayerState | null>(null);

  const playerIdRef = useRef<string>("");
  const playerNameRef = useRef<string>("Player");
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const isHostRef = useRef(false);
  const finishTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Distinguishes "we've received the opponent's real finish broadcast"
  // from "we've merely guessed their result from their last known position".
  // Only the former should stop us resending OUR OWN finish broadcast to
  // them — otherwise our own estimate-setting was accidentally cancelling
  // the safety-net resends meant to make sure THEY get OUR real number,
  // which is what caused the two devices to disagree on the final result.
  const receivedAuthoritativeFinishRef = useRef(false);
  const reconcilePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [reconciled, setReconciled] = useState(false);

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
          remoteStateRef.current = payload as RemotePlayerState;
          if (payload.playerName) setOpponentName(payload.playerName);
        }
      })
      .on("broadcast", { event: "finish" }, ({ payload }) => {
        if (payload.playerId !== playerIdRef.current) {
          // Authoritative — always overwrite our estimate with the real value.
          setOpponentResult(payload.distance);
          receivedAuthoritativeFinishRef.current = true;
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
      if (reconcilePollRef.current) clearInterval(reconcilePollRef.current);
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

    // Show a fast estimate immediately using the opponent's last known
    // broadcast position, so the screen isn't blank while we wait.
    setOpponentResult((prev) => prev ?? remoteStateRef.current?.distance ?? 0);

    const sendFinish = () => {
      channelRef.current?.send({
        type: "broadcast",
        event: "finish",
        payload: { playerId: playerIdRef.current, distance: finalDistance },
      });
    };
    sendFinish();
    let attempts = 0;
    finishTimerRef.current = setInterval(() => {
      attempts += 1;
      sendFinish();
      if (attempts >= 15 && finishTimerRef.current) {
        clearInterval(finishTimerRef.current);
      }
    }, 1000);

    // Authoritative path: write our own result to the database, then poll
    // the room row until BOTH players' distances are present, and use
    // those exact two numbers as the final, guaranteed-consistent result —
    // this is what both devices ultimately agree on, regardless of whether
    // any broadcast message got dropped along the way.
    if (room?.id) {
      let pollAttempts = 0;
      reportFinish(room.id, isHostRef.current, finalDistance).catch(() => {
        // If this write fails (e.g. transient network issue), the poll
        // below will simply keep retrying the read side; we don't need
        // special handling here.
      });

      reconcilePollRef.current = setInterval(async () => {
        pollAttempts += 1;
        try {
          const r = await fetchRoom(room.id);
          const mine = isHostRef.current ? r.player1_distance : r.player2_distance;
          const theirs = isHostRef.current ? r.player2_distance : r.player1_distance;
          if (mine !== null && theirs !== null) {
            setMyResult(mine);
            setOpponentResult(theirs);
            setReconciled(true);
            receivedAuthoritativeFinishRef.current = true;
            if (reconcilePollRef.current) clearInterval(reconcilePollRef.current);
            if (finishTimerRef.current) clearInterval(finishTimerRef.current);
          }
        } catch {
          // keep retrying on the next tick
        }
        if (pollAttempts >= 25 && reconcilePollRef.current) {
          // ~20s cap — if we still don't have both sides by now, something's
          // wrong (opponent likely disconnected); stop polling rather than
          // running forever. The estimated result stays on screen.
          clearInterval(reconcilePollRef.current);
        }
      }, 800);
    }
  };

  // Stop resending once we've heard the opponent's REAL finish broadcast —
  // not just our own estimate of it (see receivedAuthoritativeFinishRef
  // comment above for why this distinction matters).
  useEffect(() => {
    if (receivedAuthoritativeFinishRef.current && finishTimerRef.current) {
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
          <p>{opponentName}: {Math.floor(opponentResult ?? 0)}m</p>
          <h2>{tied ? "It's a tie!" : iWon ? "You win! 🎉" : `${opponentName} wins`}</h2>
          {!reconciled && (
            <p style={{ color: "#999", fontSize: 13 }}>Confirming final result…</p>
          )}
        </div>
      )}
    </main>
  );
}
