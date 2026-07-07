"use client";

// components/DinoCanvas.tsx
//
// Renders ONE local dino + track using the shared engine, and optionally
// draws a second "ghost" dino from remote/second-local state on the same
// track. This same component is meant to be reused for:
//   - Phase 1 (online multiplayer): remoteState comes from a Supabase
//     Realtime broadcast subscription.
//   - Phase 2 (local split-screen): remoteState comes from a second local
//     engine instance driven by a different keymap, no network involved.
//
// Keeping "where does remote state come from" outside this component is
// the whole point — this file doesn't know or care.

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_CONFIG,
  createEngine,
  updateEngine,
  EngineState,
  InputState,
} from "../lib/gameEngine";
import { RemotePlayerState } from "../lib/types";

interface DinoCanvasProps {
  seed: number;
  distanceGoal: number; // px distance to finish line
  keymap?: { jump: string[]; duck: string[] }; // for split-screen: differing keys per player
  remoteState?: RemotePlayerState | null;
  onLocalUpdate?: (state: {
    distance: number;
    y: number;
    isDucking: boolean;
    isStumbling: boolean;
    isBoosted: boolean;
  }) => void;
  onFinish?: () => void;
  width?: number;
  height?: number;
}

const DEFAULT_KEYMAP = { jump: ["Space", "ArrowUp"], duck: ["ArrowDown"] };

export default function DinoCanvas({
  seed,
  distanceGoal,
  keymap = DEFAULT_KEYMAP,
  remoteState,
  onLocalUpdate,
  onFinish,
  width = 900,
  height = 300,
}: DinoCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<EngineState>(createEngine({ ...DEFAULT_CONFIG, seed }));
  const inputRef = useRef<InputState>({ jumpPressed: false, duckPressed: false });
  const finishedRef = useRef(false);
  const rafRef = useRef<number>(0);
  const lastTsRef = useRef<number>(0);
  const [, forceRender] = useState(0); // only used to trigger a final re-render on finish

  // --- Keyboard input ---
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (keymap.jump.includes(e.code)) inputRef.current.jumpPressed = true;
      if (keymap.duck.includes(e.code)) inputRef.current.duckPressed = true;
    };
    const up = (e: KeyboardEvent) => {
      if (keymap.jump.includes(e.code)) inputRef.current.jumpPressed = false;
      if (keymap.duck.includes(e.code)) inputRef.current.duckPressed = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [keymap]);

  // --- Game loop ---
  useEffect(() => {
    const config = { ...DEFAULT_CONFIG, seed };

    const loop = (ts: number) => {
      if (!lastTsRef.current) lastTsRef.current = ts;
      const dtMs = Math.min(ts - lastTsRef.current, 50); // clamp to avoid huge jumps on tab-switch
      lastTsRef.current = ts;

      if (!finishedRef.current) {
        engineRef.current = updateEngine(
          engineRef.current,
          inputRef.current,
          config,
          dtMs,
          performance.timeOrigin + ts
        );

        onLocalUpdate?.({
          distance: engineRef.current.dino.distance,
          y: engineRef.current.dino.y,
          isDucking: engineRef.current.dino.isDucking,
          isStumbling: engineRef.current.dino.isStumbling,
          isBoosted: engineRef.current.dino.isBoosted,
        });

        if (engineRef.current.dino.distance >= distanceGoal) {
          finishedRef.current = true;
          onFinish?.();
          forceRender((n) => n + 1);
        }
      }

      draw(canvasRef.current, engineRef.current, remoteState, config, width, height);
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, distanceGoal, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ background: "#f7f7f7", borderBottom: "2px solid #535353" }}
    />
  );
}

function draw(
  canvas: HTMLCanvasElement | null,
  engine: EngineState,
  remote: RemotePlayerState | null | undefined,
  config: typeof DEFAULT_CONFIG,
  width: number,
  height: number
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const groundY = height - 40;

  ctx.clearRect(0, 0, width, height);

  // Ground line
  ctx.strokeStyle = "#535353";
  ctx.beginPath();
  ctx.moveTo(0, groundY);
  ctx.lineTo(width, groundY);
  ctx.stroke();

  // Obstacles
  ctx.fillStyle = "#535353";
  for (const o of engine.obstacles) {
    ctx.fillRect(o.x, groundY + o.y - o.height, o.width, o.height);
  }

  // Power-ups
  for (const p of engine.powerUps) {
    if (p.collected) continue;
    ctx.fillStyle = "#ffb300";
    ctx.beginPath();
    ctx.arc(
      p.x + p.width / 2,
      groundY + p.y + p.height / 2,
      p.width / 2,
      0,
      Math.PI * 2
    );
    ctx.fill();
  }

  // Local dino
  drawDino(
    ctx,
    80,
    groundY,
    engine.dino.y,
    engine.dino.isDucking,
    engine.dino.isStumbling,
    engine.dino.isBoosted,
    config,
    "#333"
  );

  // Remote/ghost dino (drawn slightly transparent, offset a bit vertically
  // so the two dinos don't fully overlap when neck-and-neck)
  if (remote) {
    ctx.globalAlpha = 0.75;
    drawDino(
      ctx,
      80,
      groundY - 14,
      remote.y,
      remote.isDucking,
      remote.isStumbling,
      remote.isBoosted,
      config,
      "#0077cc"
    );
    ctx.globalAlpha = 1;
  }

  // Distance readout
  ctx.fillStyle = "#333";
  ctx.font = "16px monospace";
  ctx.fillText(`${Math.floor(engine.dino.distance)}m`, width - 90, 24);
  if (remote) {
    ctx.fillStyle = "#0077cc";
    ctx.fillText(`${Math.floor(remote.distance)}m`, width - 90, 44);
  }
}

function drawDino(
  ctx: CanvasRenderingContext2D,
  x: number,
  groundY: number,
  y: number,
  isDucking: boolean,
  isStumbling: boolean,
  isBoosted: boolean,
  config: typeof DEFAULT_CONFIG,
  color: string
) {
  const h = isDucking ? config.duckHeight : config.dinoHeight;
  const w = config.dinoWidth;
  const top = groundY + y - h;

  ctx.fillStyle = isStumbling ? "#cc3333" : color;
  ctx.fillRect(x, top, w, h);

  if (isBoosted) {
    // simple speed-lines behind the dino
    ctx.strokeStyle = "#ffb300";
    ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(x - 10 - i * 8, top + 10 + i * 10);
      ctx.lineTo(x - 25 - i * 8, top + 10 + i * 10);
      ctx.stroke();
    }
  }
}
