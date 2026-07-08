"use client";

// app/multiplayer/[code]/page.tsx
//
// Full room lifecycle for N players, all on one Realtime channel scoped to
// the room code:
//
//   waiting -> countdown -> racing -> results
//
// - "waiting": everyone in the room is tracked via Presence (playerId,
//   name, ready). The host sees a "Start Race" button once at least 2
//   players are present and everyone (including the host) is ready.
// - "countdown": host clicked Start — a 5s countdown is broadcast with a
//   shared target timestamp so every client counts down in sync. The host
//   can cancel and return everyone to the waiting room (e.g. to let one
//   more player join).
// - "racing": the actual DinoCanvas race, synced to the countdown's end
//   time. Live positions travel over Broadcast (fast, ~10/sec, not
//   guaranteed); final results are written to the race_results table so
//   every player's screen ends up agreeing on the exact same numbers even
//   if some in-race broadcast messages were dropped.
// - "results": leaderboard sorted by distance, with Rematch (host creates
//   a fresh room and everyone is redirected automatically) and Home
//   buttons.

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import DinoCanvas from "../../../components/DinoCanvas";
import { supabase } from "../../../lib/supabaseClient";
import {
  GameRoom,
  RaceResult,
  createRematchRoom,
  getPlayerId,
  getPlayerName,
  getRoomByCode,
  reportRaceResult,
  fetchRaceResults,
} from "../../../lib/rooms";
import { RemotePlayerState } from "../../../lib/types";

type Phase = "waiting" | "countdown" | "racing" | "results";

interface PresenceInfo {
  playerId: string;
  playerName: string;
  ready: boolean;
}

export default function RoomPage() {
  const params = useParams();
  const router = useRouter();
  const code = (params?.code as string)?.toUpperCase();

  const [room, setRoom] = useState<GameRoom | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("waiting");
  const [players, setPlayers] = useState<PresenceInfo[]>([]);
  const [myReady, setMyReady] = useState(false);
  const [countdownEndsAt, setCountdownEndsAt] = useState<number | null>(null);
  const [countdownLeft, setCountdownLeft] = useState(5);
  const [raceStartAt, setRaceStartAt] = useState<number | null>(null);
  const [remoteStates, setRemoteStates] = useState<Record<string, RemotePlayerState>>({});
  const [myResult, setMyResult] = useState<number | null>(null);
  const [results, setResults] = useState<RaceResult[]>([]);
  const [reconciling, setReconciling] = useState(false);

  const playerIdRef = useRef("");
  const playerNameRef = useRef("Player");
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const myReadyRef = useRef(false);
  const finishTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const resultsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSentAtRef = useRef(0);
  const expectedPlayerCountRef = useRef(0);

  const isHost = room?.host_id === playerIdRef.current;

  // --- Load room + set up identity ---
  useEffect(() => {
    if (!code) return;
    playerIdRef.current = getPlayerId();
    playerNameRef.current = getPlayerName();

    getRoomByCode(code)
      .then(setRoom)
      .catch((e) => setError(e instanceof Error ? e.message : "Room not found"));
  }, [code]);

  // --- Realtime channel: presence for room membership, broadcast for
  //     countdown/state/finish events ---
  useEffect(() => {
    if (!code) return;

    const channel = supabase.channel(`room-${code}`, {
      config: { broadcast: { self: false }, presence: { key: getPlayerId() } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        const list: PresenceInfo[] = Object.values(state)
          .flat()
          .map((p: any) => ({ playerId: p.playerId, playerName: p.playerName, ready: p.ready }));
        setPlayers(list);
      })
      .on("broadcast", { event: "countdown-start" }, ({ payload }) => {
        setCountdownEndsAt(payload.endsAt);
        setPhase("countdown");
      })
      .on("broadcast", { event: "countdown-cancel" }, () => {
        setCountdownEndsAt(null);
        setPhase("waiting");
      })
      .on("broadcast", { event: "race-start" }, ({ payload }) => {
        expectedPlayerCountRef.current = payload.playerCount;
        setRaceStartAt(payload.startAt);
        setPhase("racing");
      })
      .on("broadcast", { event: "state" }, ({ payload }) => {
        if (payload.playerId === playerIdRef.current) return;
        setRemoteStates((prev) => ({ ...prev, [payload.playerId]: payload as RemotePlayerState }));
      })
      .on("broadcast", { event: "rematch" }, ({ payload }) => {
        router.push(`/multiplayer/${payload.code}`);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({
            playerId: playerIdRef.current,
            playerName: playerNameRef.current,
            ready: false,
          });
        }
      });

    channelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
      if (finishTimerRef.current) clearInterval(finishTimerRef.current);
      if (resultsPollRef.current) clearInterval(resultsPollRef.current);
    };
  }, [code, router]);

  // --- Countdown ticking + host resolves it into the actual race start ---
  useEffect(() => {
    if (phase !== "countdown" || !countdownEndsAt) return;

    const tick = () => {
      const left = Math.ceil((countdownEndsAt - Date.now()) / 1000);
      setCountdownLeft(Math.max(0, left));
      if (Date.now() >= countdownEndsAt) {
        if (isHost) {
          channelRef.current?.send({
            type: "broadcast",
            event: "race-start",
            payload: { startAt: countdownEndsAt, playerCount: players.length },
          });
        }
      }
    };
    tick();
    const interval = setInterval(tick, 200);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, countdownEndsAt, isHost]);

  const toggleReady = () => {
    const next = !myReadyRef.current;
    myReadyRef.current = next;
    setMyReady(next);
    channelRef.current?.track({
      playerId: playerIdRef.current,
      playerName: playerNameRef.current,
      ready: next,
    });
  };

  const allReady = players.length >= 2 && players.every((p) => p.ready);

  const handleStartRace = () => {
    if (!isHost || !allReady) return;
    const endsAt = Date.now() + 5000;
    channelRef.current?.send({
      type: "broadcast",
      event: "countdown-start",
      payload: { endsAt },
    });
    setCountdownEndsAt(endsAt);
    setPhase("countdown");
  };

  const handleCancelCountdown = () => {
    if (!isHost) return;
    channelRef.current?.send({ type: "broadcast", event: "countdown-cancel", payload: {} });
    setCountdownEndsAt(null);
    setPhase("waiting");
  };

  const handleLocalUpdate = (state: {
    distance: number;
    y: number;
    isDucking: boolean;
    isStumbling: boolean;
    isBoosted: boolean;
  }) => {
    const now = Date.now();
    if (now - lastSentAtRef.current < 100) return; // throttle to ~10/sec
    lastSentAtRef.current = now;

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
        updatedAt: now,
      },
    });
  };

  const handleFinish = (finalDistance: number) => {
    setMyResult(finalDistance);
    if (!room?.id) return;

    reportRaceResult(room.id, playerIdRef.current, playerNameRef.current, finalDistance).catch(() => {});

    let attempts = 0;
    resultsPollRef.current = setInterval(async () => {
      attempts += 1;
      try {
        const rows = await fetchRaceResults(room.id);
        setResults(rows);
        const expected = expectedPlayerCountRef.current || players.length;
        if (rows.length >= expected) {
          setPhase("results");
          setReconciling(false);
          if (resultsPollRef.current) clearInterval(resultsPollRef.current);
        }
      } catch {
        // retry next tick
      }
      if (attempts >= 25 && resultsPollRef.current) {
        // ~20s cap in case someone disconnected mid-race
        setPhase("results");
        setReconciling(false);
        clearInterval(resultsPollRef.current);
      }
    }, 800);
    setReconciling(true);
  };

  const handleRematch = async () => {
    if (!isHost || !room) return;
    try {
      const newRoom = await createRematchRoom(room.duration_ms);
      channelRef.current?.send({
        type: "broadcast",
        event: "rematch",
        payload: { code: newRoom.code },
      });
      router.push(`/multiplayer/${newRoom.code}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start rematch");
    }
  };

  if (error) {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <p style={{ color: "#cc3333" }}>{error}</p>
        <p><Link href="/multiplayer">← Back to lobby</Link></p>
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

  // --- Waiting room ---
  if (phase === "waiting") {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 480 }}>
        <h1>Room {code}</h1>
        <p style={{ color: "#666" }}>Share this code so others can join.</p>

        <ul style={{ listStyle: "none", padding: 0, marginTop: 16 }}>
          {players.map((p) => (
            <li
              key={p.playerId}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "8px 12px",
                border: "1px solid #ddd",
                borderRadius: 8,
                marginBottom: 6,
              }}
            >
              <span>
                {p.playerName}
                {p.playerId === room.host_id && " (host)"}
                {p.playerId === playerIdRef.current && " — you"}
              </span>
              <span style={{ color: p.ready ? "#009966" : "#999" }}>
                {p.ready ? "Ready" : "Not ready"}
              </span>
            </li>
          ))}
        </ul>

        <button
          onClick={toggleReady}
          style={{
            marginTop: 12,
            width: "100%",
            padding: "12px 0",
            borderRadius: 8,
            border: "1px solid #333",
            background: myReady ? "#009966" : "#fff",
            color: myReady ? "#fff" : "#333",
            fontSize: 15,
          }}
        >
          {myReady ? "Ready ✓ (tap to unready)" : "I'm Ready"}
        </button>

        {isHost && (
          <button
            onClick={handleStartRace}
            disabled={!allReady}
            style={{
              marginTop: 12,
              width: "100%",
              padding: "12px 0",
              borderRadius: 8,
              border: "1px solid #333",
              background: allReady ? "#333" : "#eee",
              color: allReady ? "#fff" : "#999",
              fontSize: 15,
            }}
          >
            {players.length < 2
              ? "Waiting for at least 2 players…"
              : allReady
              ? "Start Race"
              : "Waiting for everyone to be ready…"}
          </button>
        )}
        {!isHost && (
          <p style={{ color: "#999", fontSize: 13, marginTop: 12 }}>
            Waiting for the host to start the race once everyone's ready.
          </p>
        )}
      </main>
    );
  }

  // --- Countdown ---
  if (phase === "countdown") {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui", textAlign: "center" }}>
        <h1 style={{ fontSize: 64 }}>{countdownLeft}</h1>
        <p>Get ready…</p>
        {isHost && (
          <button
            onClick={handleCancelCountdown}
            style={{
              marginTop: 16,
              padding: "10px 20px",
              borderRadius: 8,
              border: "1px solid #cc3333",
              background: "#fff",
              color: "#cc3333",
            }}
          >
            Cancel (e.g. to let another player join)
          </button>
        )}
      </main>
    );
  }

  // --- Racing ---
  if (phase === "racing") {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <h1>Race — Room {code}</h1>
        <DinoCanvas
          seed={room.seed}
          durationMs={room.duration_ms}
          raceStartAt={raceStartAt ?? Date.now()}
          remoteStates={Object.values(remoteStates)}
          localPlayerName={playerNameRef.current}
          onLocalUpdate={handleLocalUpdate}
          onFinish={handleFinish}
        />
        {myResult !== null && reconciling && (
          <p style={{ color: "#999", fontSize: 13, marginTop: 12 }}>
            Finished! Confirming everyone's final result…
          </p>
        )}
      </main>
    );
  }

  // --- Results ---
  const sorted = [...results].sort((a, b) => b.distance - a.distance);

  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 480 }}>
      <h1>Results — Room {code}</h1>
      <ol style={{ paddingLeft: 20, marginTop: 16 }}>
        {sorted.map((r) => (
          <li
            key={r.player_id}
            style={{
              padding: "6px 0",
              fontWeight: r.player_id === playerIdRef.current ? "bold" : "normal",
            }}
          >
            {r.player_name}
            {r.player_id === playerIdRef.current && " (you)"}: {Math.floor(r.distance)}m
          </li>
        ))}
      </ol>
      {sorted.length > 0 && <h2>{sorted[0].player_name} wins! 🎉</h2>}

      <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
        {isHost ? (
          <button
            onClick={handleRematch}
            style={{
              flex: 1,
              padding: "12px 0",
              borderRadius: 8,
              border: "1px solid #333",
              background: "#333",
              color: "#fff",
              fontSize: 15,
            }}
          >
            Rematch
          </button>
        ) : (
          <button
            disabled
            style={{
              flex: 1,
              padding: "12px 0",
              borderRadius: 8,
              border: "1px solid #ddd",
              background: "#f5f5f5",
              color: "#999",
              fontSize: 15,
            }}
          >
            Waiting for host to rematch…
          </button>
        )}
        <Link
          href="/"
          style={{
            flex: 1,
            padding: "12px 0",
            borderRadius: 8,
            border: "1px solid #333",
            textAlign: "center",
            textDecoration: "none",
            color: "#333",
            fontSize: 15,
          }}
        >
          Home
        </Link>
      </div>
    </main>
  );
}