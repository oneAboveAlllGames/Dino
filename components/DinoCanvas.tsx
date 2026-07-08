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
  distanceGoal?: number; // px distance to finish line (used if durationMs not set)
  durationMs?: number; // if set, race runs for this long instead of to a distance goal
  raceStartAt?: number; // shared epoch ms timestamp both players count down from (for sync)
  keymap?: { jump: string[]; duck: string[] }; // for split-screen: differing keys per player
  remoteStates?: RemotePlayerState[];
  localPlayerName?: string;
  onLocalUpdate?: (state: {
    distance: number;
    y: number;
    isDucking: boolean;
    isStumbling: boolean;
    isBoosted: boolean;
  }) => void;
  onFinish?: (finalDistance: number) => void;
  width?: number;
  height?: number;
}

const DEFAULT_KEYMAP = { jump: ["Space", "ArrowUp"], duck: ["ArrowDown"] };

function formatTime(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Fixed boost counts for the three standard race lengths, spread evenly
// across the whole race by lib/gameEngine's computeBoostSchedule. Falls
// back to a rough 1-per-12s ratio for any non-standard duration.
function boostCountForDuration(durationMs: number): number {
  if (durationMs === 90_000) return 6;
  if (durationMs === 120_000) return 10;
  if (durationMs === 180_000) return 15;
  return Math.max(1, Math.round(durationMs / 12_000));
}

export default function DinoCanvas({
  seed,
  distanceGoal,
  durationMs,
  raceStartAt,
  keymap = DEFAULT_KEYMAP,
  remoteStates = [],
  localPlayerName = "You",
  onLocalUpdate,
  onFinish,
  width = 900,
  height = 300,
}: DinoCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const raceDurationMs = durationMs ?? DEFAULT_CONFIG.raceDurationMs;
  const engineRef = useRef<EngineState>(
    createEngine({
      ...DEFAULT_CONFIG,
      seed,
      raceDurationMs,
      boostCount: boostCountForDuration(raceDurationMs),
    })
  );
  const inputRef = useRef<InputState>({ jumpPressed: false, duckPressed: false });
  const finishedRef = useRef(false);
  const rafRef = useRef<number>(0);
  const lastTsRef = useRef<number>(0);
  const startAtRef = useRef<number>(raceStartAt ?? Date.now());
  const remoteStatesRef = useRef<RemotePlayerState[]>(remoteStates);
  const [timeLeftMs, setTimeLeftMs] = useState<number | null>(
    durationMs ? durationMs : null
  );
  const [, forceRender] = useState(0); // only used to trigger a final re-render on finish

  // Keep the ref in sync with the latest prop so the animation loop (whose
  // closure is only created once per game-config change) always reads the
  // freshest opponent state rather than whatever it was when the loop started.
  useEffect(() => {
    remoteStatesRef.current = remoteStates;
  }, [remoteStates]);

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

  // --- Touch controls (mobile has no keyboard) ---
  // Tap/hold the canvas itself to jump. A dedicated on-screen duck button
  // below the canvas handles ducking, since holding-to-duck via a plain tap
  // on the canvas would conflict with jump taps.
  const handleJumpStart = () => {
    inputRef.current.jumpPressed = true;
  };
  const handleJumpEnd = () => {
    inputRef.current.jumpPressed = false;
  };
  const handleDuckStart = () => {
    inputRef.current.duckPressed = true;
  };
  const handleDuckEnd = () => {
    inputRef.current.duckPressed = false;
  };


  useEffect(() => {
    const config = {
      ...DEFAULT_CONFIG,
      seed,
      raceDurationMs,
      boostCount: boostCountForDuration(raceDurationMs),
    };

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

        if (durationMs) {
          const elapsed = performance.timeOrigin + ts - startAtRef.current;
          const remaining = Math.max(0, durationMs - elapsed);
          setTimeLeftMs(remaining);
          if (remaining <= 0) {
            finishedRef.current = true;
            onFinish?.(engineRef.current.dino.distance);
            forceRender((n) => n + 1);
          }
        } else if (distanceGoal && engineRef.current.dino.distance >= distanceGoal) {
          finishedRef.current = true;
          onFinish?.(engineRef.current.dino.distance);
          forceRender((n) => n + 1);
        }
      }

      draw(canvasRef.current, engineRef.current, remoteStatesRef.current, config, width, height, localPlayerName);
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, distanceGoal, durationMs, raceStartAt, width, height, localPlayerName]);

  return (
    <div>
      {durationMs && timeLeftMs !== null && (
        <div
          style={{
            fontFamily: "monospace",
            fontSize: 20,
            marginBottom: 8,
            fontWeight: "bold",
          }}
        >
          {formatTime(timeLeftMs)}
        </div>
      )}
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        onMouseDown={handleJumpStart}
        onMouseUp={handleJumpEnd}
        onMouseLeave={handleJumpEnd}
        onTouchStart={(e) => {
          e.preventDefault();
          handleJumpStart();
        }}
        onTouchEnd={(e) => {
          e.preventDefault();
          handleJumpEnd();
        }}
        style={{
          background: "#f7f7f7",
          borderBottom: "2px solid #535353",
          width: "100%",
          maxWidth: width,
          touchAction: "none",
        }}
      />
      {/* Mobile controls — hidden on larger screens via CSS below isn't
          available inline, so we just always show them; they're harmless
          (if unnecessary) on desktop, which still uses the keyboard. */}
      <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
        <button
          onMouseDown={handleJumpStart}
          onMouseUp={handleJumpEnd}
          onMouseLeave={handleJumpEnd}
          onTouchStart={(e) => {
            e.preventDefault();
            handleJumpStart();
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
            handleJumpEnd();
          }}
          style={{
            flex: 1,
            padding: "16px 0",
            fontSize: 16,
            borderRadius: 8,
            border: "1px solid #535353",
            background: "#fff",
            touchAction: "none",
          }}
        >
          Jump
        </button>
        <button
          onMouseDown={handleDuckStart}
          onMouseUp={handleDuckEnd}
          onMouseLeave={handleDuckEnd}
          onTouchStart={(e) => {
            e.preventDefault();
            handleDuckStart();
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
            handleDuckEnd();
          }}
          style={{
            flex: 1,
            padding: "16px 0",
            fontSize: 16,
            borderRadius: 8,
            border: "1px solid #535353",
            background: "#fff",
            touchAction: "none",
          }}
        >
          Duck
        </button>
      </div>
    </div>
  );
}

const OPPONENT_COLORS = ["#0077cc", "#cc0077", "#009966", "#cc8800", "#7733cc", "#0099aa"];

function draw(
  canvas: HTMLCanvasElement | null,
  engine: EngineState,
  remotes: RemotePlayerState[],
  config: typeof DEFAULT_CONFIG,
  width: number,
  height: number,
  localPlayerName: string
) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const groundY = height - 40;
  const PLAYER_X = 80;

  ctx.clearRect(0, 0, width, height);

  // Ground line
  ctx.strokeStyle = "#535353";
  ctx.beginPath();
  ctx.moveTo(0, groundY);
  ctx.lineTo(width, groundY);
  ctx.stroke();

  // Obstacles: airborne ones (birds) rendered as clouds, ground ones
  // (cacti) rendered as flames. Faded once already hit — the player passes
  // through them for the rest of their lifetime, so the fade signals "safe now".
  for (const o of engine.obstacles) {
    const alpha = o.hit ? 0.25 : 1;
    if (o.type === "bird") {
      drawCloud(ctx, o.x, groundY + o.y - o.height, o.width, o.height, alpha);
    } else {
      drawFlame(ctx, o.x, groundY + o.y - o.height, o.width, o.height, alpha);
    }
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
    PLAYER_X,
    groundY,
    engine.dino.y,
    engine.dino.isDucking,
    engine.dino.isStumbling,
    engine.dino.isBoosted,
    config,
    "#333"
  );
  drawNameLabel(ctx, PLAYER_X + config.dinoWidth / 2, groundY - config.dinoHeight - 18, localPlayerName, "#333");

  // Remote/ghost dinos — each positioned relative to the ACTUAL distance
  // gap between you and them (scaled down so it fits on screen), so passing
  // an opponent is visually meaningful rather than everyone overlapping you.
  // Each opponent gets a distinct color and a small vertical offset (by
  // index) so multiple ghosts near the same position stay distinguishable.
  const minX = 16;
  const maxX = width - config.dinoWidth - 16;
  const scale = 0.15; // compress world-distance gap into screen pixels
  let edgeStackTop = 0; // stacks off-screen indicator labels so they don't overlap
  let edgeStackBottom = 0;

  remotes.forEach((remote, i) => {
    const color = OPPONENT_COLORS[i % OPPONENT_COLORS.length];
    const gap = remote.distance - engine.dino.distance;
    const rawX = PLAYER_X + gap * scale;
    const clampedX = Math.max(minX, Math.min(maxX, rawX));
    const offscreen = rawX !== clampedX;
    const yOffset = -16 - (i % 3) * 10; // stagger overlapping ghosts vertically

    ctx.globalAlpha = 0.8;
    drawDino(
      ctx,
      clampedX,
      groundY + yOffset,
      remote.y,
      remote.isDucking,
      remote.isStumbling,
      remote.isBoosted,
      config,
      color
    );
    ctx.globalAlpha = 1;
    drawNameLabel(
      ctx,
      clampedX + config.dinoWidth / 2,
      groundY + yOffset - config.dinoHeight - 18,
      remote.playerName || "Opponent",
      color
    );

    // Off-screen direction arrow + live gap number — the marker itself
    // stops moving once clamped to the edge, so without this number it
    // looks like your lead has stalled even though it's still growing.
    if (offscreen) {
      const isLeft = rawX < minX;
      const arrowX = isLeft ? 26 : width - 26;
      const arrowDir = isLeft ? -1 : 1;
      const stackIndex = isLeft ? edgeStackTop++ : edgeStackBottom++;
      const arrowY = groundY - 20 - stackIndex * 16;

      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(arrowX + arrowDir * 6, arrowY);
      ctx.lineTo(arrowX - arrowDir * 6, arrowY - 6);
      ctx.lineTo(arrowX - arrowDir * 6, arrowY + 6);
      ctx.closePath();
      ctx.fill();

      const gapLabel = `${gap < 0 ? "+" : ""}${Math.abs(Math.round(gap))}m ${gap < 0 ? "ahead" : "behind"}`;
      ctx.font = "11px monospace";
      ctx.textAlign = arrowDir < 0 ? "left" : "right";
      ctx.fillText(gapLabel, arrowDir < 0 ? arrowX + 12 : arrowX - 12, arrowY);
      ctx.textAlign = "start";
    }
  });

  // Distance readout / mini leaderboard, top-right
  ctx.fillStyle = "#333";
  ctx.font = "14px monospace";
  ctx.fillText(`${Math.floor(engine.dino.distance)}m`, width - 90, 20);
  remotes.forEach((remote, i) => {
    ctx.fillStyle = OPPONENT_COLORS[i % OPPONENT_COLORS.length];
    ctx.fillText(`${Math.floor(remote.distance)}m`, width - 90, 20 + (i + 1) * 18);
  });
}

function drawNameLabel(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  name: string,
  color: string
) {
  ctx.fillStyle = color;
  ctx.font = "12px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(name, cx, y);
  ctx.textAlign = "start";
}

// Original knight-bug character (not based on any copyrighted design):
// a small hollow-eyed insect-knight in a cloak, with distinct silhouettes
// for standing, jumping, ducking, and stumbling. Drawn entirely with canvas
// primitives — no image assets needed.
function drawDino(
  ctx: CanvasRenderingContext2D,
  x: number,
  groundY: number,
  y: number,
  isDucking: boolean,
  isStumbling: boolean,
  isBoosted: boolean,
  config: typeof DEFAULT_CONFIG,
  tint: string
) {
  const w = config.dinoWidth;
  const bodyColor = isStumbling ? "#8a3a3a" : tint;
  const cloakColor = isStumbling ? "#5c2626" : shade(tint, -25);
  const eyeColor = "#f5c84c";

  ctx.save();

  if (isDucking) {
    // --- Duck pose: low, elongated, horns swept back ---
    const cx = x + w / 2;
    const baseY = groundY + y;
    const bodyTop = baseY - config.duckHeight;

    ctx.fillStyle = cloakColor;
    ctx.beginPath();
    ctx.moveTo(x + 2, baseY);
    ctx.quadraticCurveTo(x - 6, bodyTop + 6, x + 10, bodyTop);
    ctx.lineTo(x + w - 10, bodyTop);
    ctx.quadraticCurveTo(x + w + 6, bodyTop + 6, x + w - 2, baseY);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.ellipse(cx, bodyTop + 6, w / 2 - 4, 9, 0, 0, Math.PI * 2);
    ctx.fill();

    drawHorn(ctx, cx - 10, bodyTop, -18, -4, cloakColor);
    drawHorn(ctx, cx + 10, bodyTop, 18, -4, cloakColor);

    ctx.fillStyle = eyeColor;
    ctx.beginPath();
    ctx.ellipse(cx - 6, bodyTop + 6, 3, 4, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + 6, bodyTop + 6, 3, 4, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // --- Stand / jump pose: upright cloaked figure ---
    const h = config.dinoHeight;
    const cx = x + w / 2;
    const baseY = groundY + y;
    const bodyTop = baseY - h;
    const headCy = bodyTop + h * 0.35;
    const bodyRy = h * 0.4;

    const flare = y < 0 ? 6 : 0;
    ctx.fillStyle = cloakColor;
    ctx.beginPath();
    ctx.moveTo(cx - w / 2 + 6, baseY);
    ctx.quadraticCurveTo(cx - w / 2 - flare, headCy + bodyRy * 0.6, cx - w * 0.3, headCy);
    ctx.lineTo(cx + w * 0.3, headCy);
    ctx.quadraticCurveTo(cx + w / 2 + flare, headCy + bodyRy * 0.6, cx + w / 2 - 6, baseY);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = bodyColor;
    ctx.beginPath();
    ctx.ellipse(cx, headCy, w * 0.34, bodyRy * 0.75, 0, 0, Math.PI * 2);
    ctx.fill();

    drawHorn(ctx, cx - w * 0.2, headCy - bodyRy * 0.5, -10, -16, cloakColor);
    drawHorn(ctx, cx + w * 0.2, headCy - bodyRy * 0.5, 10, -16, cloakColor);

    ctx.fillStyle = eyeColor;
    ctx.beginPath();
    ctx.ellipse(cx - w * 0.11, headCy - 1, 4, 5.5, 0, 0, Math.PI * 2);
    ctx.ellipse(cx + w * 0.11, headCy - 1, 4, 5.5, 0, 0, Math.PI * 2);
    ctx.fill();

    if (y >= -0.5) {
      ctx.strokeStyle = cloakColor;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(cx - w * 0.22, baseY - 2);
      ctx.lineTo(cx - w * 0.3, baseY + 6);
      ctx.moveTo(cx + w * 0.22, baseY - 2);
      ctx.lineTo(cx + w * 0.3, baseY + 6);
      ctx.stroke();
    }
  }

  if (isStumbling) {
    ctx.fillStyle = "#cc3333";
    ctx.font = "bold 16px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("!", x + w / 2, groundY + y - config.dinoHeight - 10);
    ctx.textAlign = "start";
  }

  ctx.restore();

  if (isBoosted) {
    ctx.strokeStyle = "#ffb300";
    ctx.lineWidth = 2;
    const top = groundY + y - (isDucking ? config.duckHeight : config.dinoHeight);
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(x - 10 - i * 8, top + 10 + i * 10);
      ctx.lineTo(x - 25 - i * 8, top + 10 + i * 10);
      ctx.stroke();
    }
  }
}

function drawCloud(
  ctx: CanvasRenderingContext2D,
  x: number,
  top: number,
  w: number,
  h: number,
  alpha: number
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#c7d3e0";
  const cy = top + h / 2;
  const r = h / 2;
  // three overlapping puffs make a simple cloud silhouette
  ctx.beginPath();
  ctx.arc(x + r, cy, r, 0, Math.PI * 2);
  ctx.arc(x + w * 0.45, cy - r * 0.35, r * 1.05, 0, Math.PI * 2);
  ctx.arc(x + w - r, cy, r * 0.85, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawFlame(
  ctx: CanvasRenderingContext2D,
  x: number,
  top: number,
  w: number,
  h: number,
  alpha: number
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  const bottom = top + h;
  const cx = x + w / 2;

  // outer flame (orange-red)
  ctx.fillStyle = "#e2521f";
  ctx.beginPath();
  ctx.moveTo(cx, top);
  ctx.quadraticCurveTo(x + w * 0.9, top + h * 0.35, cx + w * 0.2, top + h * 0.55);
  ctx.quadraticCurveTo(x + w, top + h * 0.75, cx, bottom);
  ctx.quadraticCurveTo(x, top + h * 0.75, cx - w * 0.2, top + h * 0.55);
  ctx.quadraticCurveTo(x + w * 0.1, top + h * 0.35, cx, top);
  ctx.closePath();
  ctx.fill();

  // inner flame (yellow core)
  ctx.fillStyle = "#f5c84c";
  ctx.beginPath();
  ctx.moveTo(cx, top + h * 0.32);
  ctx.quadraticCurveTo(cx + w * 0.22, top + h * 0.55, cx + w * 0.08, top + h * 0.7);
  ctx.quadraticCurveTo(cx, bottom - 2, cx, bottom);
  ctx.quadraticCurveTo(cx, bottom - 2, cx - w * 0.08, top + h * 0.7);
  ctx.quadraticCurveTo(cx - w * 0.22, top + h * 0.55, cx, top + h * 0.32);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}
function drawHorn(
  ctx: CanvasRenderingContext2D,
  baseX: number,
  baseY: number,
  dx: number,
  dy: number,
  color: string
) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(baseX - 3, baseY);
  ctx.lineTo(baseX + dx, baseY + dy);
  ctx.lineTo(baseX + 3, baseY);
  ctx.closePath();
  ctx.fill();
}

// Darkens/lightens a hex color by `percent` (-100 to 100), used to derive
// the cloak shade from the main tint color.
function shade(hex: string, percent: number): string {
  const num = parseInt(hex.replace("#", ""), 16);
  const amt = Math.round(2.55 * percent);
  const r = Math.max(0, Math.min(255, (num >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0x00ff) + amt));
  const b = Math.max(0, Math.min(255, (num & 0x0000ff) + amt));
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}