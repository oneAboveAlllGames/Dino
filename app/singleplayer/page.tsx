"use client";

// app/singleplayer/page.tsx
//
// Endless survival mode: starts slow and easy, speed steps up every 30s,
// any obstacle touch ends the run immediately (no stumble grace). Local
// personal best is stored in localStorage (instant, no network needed);
// every run is also submitted to a global leaderboard showing the top 10
// all-time scores. A name is required before playing since it's what gets
// shown on the leaderboard.

import { useEffect, useState } from "react";
import Link from "next/link";
import DinoCanvas from "../../components/DinoCanvas";
import { getPlayerName, setPlayerName } from "../../lib/rooms";
import {
  EndlessScore,
  fetchTopEndlessScores,
  getLocalHighScore,
  saveLocalHighScoreIfBetter,
  submitEndlessScore,
} from "../../lib/endless";

type Phase = "setup" | "playing" | "gameover";

export default function SinglePlayerPage() {
  const [phase, setPhase] = useState<Phase>("setup");
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [localHighScore, setLocalHighScore] = useState(0);
  const [leaderboard, setLeaderboard] = useState<EndlessScore[]>([]);
  const [seed, setSeed] = useState(1);
  const [finalScore, setFinalScore] = useState<number | null>(null);
  const [isNewHighScore, setIsNewHighScore] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const saved = getPlayerName();
    if (saved !== "Player") setName(saved);
    setLocalHighScore(getLocalHighScore());
    loadLeaderboard();
  }, []);

  const loadLeaderboard = () => {
    fetchTopEndlessScores(10)
      .then(setLeaderboard)
      .catch(() => {
        // leaderboard is a nice-to-have; if it fails to load, the game
        // still works fine locally, so we just leave the list empty.
      });
  };

  const handlePlay = () => {
    if (!name.trim()) {
      setNameError("Enter a name to play");
      return;
    }
    setPlayerName(name);
    setNameError(null);
    setSeed(Math.floor(Math.random() * 2 ** 31));
    setFinalScore(null);
    setPhase("playing");
  };

  const handleGameOver = async (distance: number) => {
    setFinalScore(distance);
    const isNew = saveLocalHighScoreIfBetter(distance);
    setIsNewHighScore(isNew);
    setLocalHighScore(getLocalHighScore());
    setPhase("gameover");

    setSubmitting(true);
    try {
      await submitEndlessScore(getPlayerName(), distance);
      loadLeaderboard();
    } catch {
      // Local high score already saved regardless — the global submission
      // is best-effort and shouldn't block the player from seeing their result.
    } finally {
      setSubmitting(false);
    }
  };

  const handlePlayAgain = () => {
    setSeed(Math.floor(Math.random() * 2 ** 31));
    setFinalScore(null);
    setPhase("playing");
  };

  if (phase === "playing") {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui" }}>
        <h1>Endless Mode</h1>
        <p style={{ color: "#666", fontSize: 14 }}>
          Speed increases every 30 seconds. One hit ends the run.
        </p>
        <DinoCanvas seed={seed} endless localPlayerName={name} onFinish={handleGameOver} />
      </main>
    );
  }

  if (phase === "gameover") {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 480 }}>
        <h1>Game Over</h1>
        <p style={{ fontSize: 20 }}>Score: {Math.floor(finalScore ?? 0)}m</p>
        {isNewHighScore && (
          <p style={{ color: "#009966", fontWeight: "bold" }}>New personal best! 🎉</p>
        )}
        <p style={{ color: "#666", fontSize: 14 }}>Your best: {Math.floor(localHighScore)}m</p>
        {submitting && <p style={{ color: "#999", fontSize: 13 }}>Submitting to leaderboard…</p>}

        <Leaderboard scores={leaderboard} />

        <div style={{ display: "flex", gap: 8, marginTop: 24 }}>
          <button
            onClick={handlePlayAgain}
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
            Play Again
          </button>
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

  // --- setup ---
  return (
    <main style={{ padding: 24, fontFamily: "system-ui", maxWidth: 480 }}>
      <h1>Endless Mode</h1>
      <p style={{ color: "#666" }}>
        Starts slow, gets faster every 30 seconds. One hit and it's over — how far can you get?
      </p>

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
        {nameError && <p style={{ color: "#cc3333", fontSize: 13, marginTop: 4 }}>{nameError}</p>}
      </section>

      <p style={{ marginTop: 16, fontSize: 14, color: "#666" }}>
        Your best: <strong>{Math.floor(localHighScore)}m</strong>
      </p>

      <button
        onClick={handlePlay}
        style={{
          marginTop: 12,
          width: "100%",
          padding: "14px 0",
          borderRadius: 8,
          border: "1px solid #333",
          background: "#333",
          color: "#fff",
          fontSize: 16,
        }}
      >
        Play
      </button>

      <Leaderboard scores={leaderboard} />

      <p style={{ marginTop: 24 }}>
        <Link href="/">← Home</Link>
      </p>
    </main>
  );
}

function Leaderboard({ scores }: { scores: EndlessScore[] }) {
  return (
    <section style={{ marginTop: 32 }}>
      <h2 style={{ fontSize: 18 }}>Top 10 All-Time</h2>
      {scores.length === 0 ? (
        <p style={{ color: "#999", fontSize: 14 }}>No scores yet — be the first!</p>
      ) : (
        <ol style={{ paddingLeft: 20, marginTop: 8 }}>
          {scores.map((s) => (
            <li key={s.id} style={{ padding: "4px 0" }}>
              {s.player_name}: {Math.floor(s.score)}m
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}