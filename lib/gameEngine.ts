// lib/gameEngine.ts
//
// Framework-agnostic game engine. No React, no canvas — just state + pure
// update functions. This is what gets shared between the online multiplayer
// mode (Phase 1) and the local split-screen mode (Phase 2): both just need
// two instances of this engine running, differing only in where input comes
// from (network vs second local keyboard listener).

import {
  DinoState,
  GameConfig,
  Obstacle,
  ObstacleType,
  PowerUp,
} from "./types";

export const DEFAULT_CONFIG: GameConfig = {
  seed: 1,
  groundY: 0,
  baseSpeed: 6,
  maxSpeed: 16,
  gravity: 0.6,
  jumpVelocity: -11,
  duckHeight: 20,
  dinoWidth: 44,
  dinoHeight: 47,
  stumbleDurationMs: 1200,
  boostDurationMs: 3000,
  boostMultiplier: 1.7,
  boostSpawnIntervalPx: 1400,
  obstacleMinGapPx: 300,
  obstacleMaxGapPx: 600,
};

// --- Seeded RNG (mulberry32) ---------------------------------------------
// Deterministic PRNG so both players in a room generate the *identical*
// obstacle/powerup sequence from a shared seed, without needing to sync
// every spawn over the network — only the seed travels.
export function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createInitialDinoState(): DinoState {
  return {
    y: 0,
    velocityY: 0,
    isJumping: false,
    isDucking: false,
    isStumbling: false,
    stumbleEndsAt: null,
    isBoosted: false,
    boostEndsAt: null,
    distance: 0,
    speed: DEFAULT_CONFIG.baseSpeed,
  };
}

export interface EngineState {
  dino: DinoState;
  obstacles: Obstacle[];
  powerUps: PowerUp[];
  worldX: number; // total scrolled distance, used to decide when to spawn next
  nextObstacleId: number;
  nextPowerUpId: number;
  nextObstacleAt: number; // worldX threshold for next spawn
  nextPowerUpAt: number;
  rng: () => number;
  gameOver: boolean; // "finished the race", not "died" — no death in this game
}

export function createEngine(config: GameConfig): EngineState {
  const rng = mulberry32(config.seed);
  return {
    dino: createInitialDinoState(),
    obstacles: [],
    powerUps: [],
    worldX: 0,
    nextObstacleId: 1,
    nextPowerUpId: 1,
    nextObstacleAt: config.obstacleMinGapPx,
    nextPowerUpAt: config.boostSpawnIntervalPx,
    rng,
    gameOver: false,
  };
}

// --- Input ----------------------------------------------------------------
export interface InputState {
  jumpPressed: boolean;
  duckPressed: boolean;
}

// --- Update -----------------------------------------------------------------
// Call once per animation frame with delta time in ms.
export function updateEngine(
  state: EngineState,
  input: InputState,
  config: GameConfig,
  dtMs: number,
  now: number
): EngineState {
  const dino = { ...state.dino };
  const dt = dtMs / (1000 / 60); // normalize to 60fps "frames"

  // --- Stumble timeout ---
  if (dino.isStumbling && dino.stumbleEndsAt !== null && now >= dino.stumbleEndsAt) {
    dino.isStumbling = false;
    dino.stumbleEndsAt = null;
  }

  // --- Boost timeout ---
  if (dino.isBoosted && dino.boostEndsAt !== null && now >= dino.boostEndsAt) {
    dino.isBoosted = false;
    dino.boostEndsAt = null;
  }

  // --- Speed ramps up gradually with distance, boosted while boost active ---
  const rampedSpeed = Math.min(
    config.baseSpeed + dino.distance / 2000,
    config.maxSpeed
  );
  dino.speed = dino.isBoosted ? rampedSpeed * config.boostMultiplier : rampedSpeed;

  // Stumbling dinos don't move forward and can't jump/duck
  const canAct = !dino.isStumbling;

  if (canAct) {
    // --- Jump ---
    if (input.jumpPressed && !dino.isJumping && !dino.isDucking) {
      dino.isJumping = true;
      dino.velocityY = config.jumpVelocity;
    }
    // --- Duck (only when grounded) ---
    dino.isDucking = input.duckPressed && !dino.isJumping;
  } else {
    dino.isDucking = false;
  }

  // --- Gravity / vertical physics ---
  if (dino.isJumping) {
    dino.velocityY += config.gravity * dt;
    dino.y += dino.velocityY * dt;
    if (dino.y >= 0) {
      dino.y = 0;
      dino.isJumping = false;
      dino.velocityY = 0;
    }
  }

  // --- Distance / world scroll (frozen while stumbling) ---
  const distanceDelta = dino.isStumbling ? 0 : dino.speed * dt;
  dino.distance += distanceDelta;
  const worldX = state.worldX + distanceDelta;

  // --- Move obstacles/powerups toward the player ---
  let obstacles = state.obstacles
    .map((o) => ({ ...o, x: o.x - distanceDelta }))
    .filter((o) => o.x + o.width > -50);

  let powerUps = state.powerUps
    .map((p) => ({ ...p, x: p.x - distanceDelta }))
    .filter((p) => p.x + p.width > -50 && !p.collected);

  let { nextObstacleId, nextPowerUpId, nextObstacleAt, nextPowerUpAt, rng } = state;

  // --- Spawn new obstacle ---
  if (worldX >= nextObstacleAt) {
    const roll = rng();
    const type: ObstacleType =
      roll < 0.45 ? "cactus-small" : roll < 0.8 ? "cactus-large" : "bird";
    const dims = obstacleDims(type, config);
    obstacles = [
      ...obstacles,
      {
        id: nextObstacleId,
        type,
        x: 900, // spawn just off right edge of a ~800-900px canvas
        y: dims.y,
        width: dims.width,
        height: dims.height,
      },
    ];
    nextObstacleId += 1;
    const gap =
      config.obstacleMinGapPx +
      rng() * (config.obstacleMaxGapPx - config.obstacleMinGapPx);
    nextObstacleAt = worldX + gap;
  }

  // --- Spawn new power-up ---
  if (worldX >= nextPowerUpAt) {
    powerUps = [
      ...powerUps,
      {
        id: nextPowerUpId,
        x: 900,
        y: -70, // floating above ground, jump-height reachable
        width: 34,
        height: 34,
        collected: false,
      },
    ];
    nextPowerUpId += 1;
    const jitter = (rng() - 0.5) * 400;
    nextPowerUpAt = worldX + config.boostSpawnIntervalPx + jitter;
  }

  // --- Collision: obstacles -> stumble ---
  // Once an obstacle has hit the player, it's marked `hit` and passed through
  // for the rest of its lifetime — it can never stumble the player a second
  // time, even though it keeps scrolling past at the same position.
  if (!dino.isStumbling) {
    obstacles = obstacles.map((o) => {
      if (!o.hit && checkDinoCollision(dino, o, config)) {
        dino.isStumbling = true;
        dino.stumbleEndsAt = now + config.stumbleDurationMs;
        dino.isJumping = false;
        dino.isDucking = false;
        dino.velocityY = 0;
        dino.y = 0;
        return { ...o, hit: true };
      }
      return o;
    });
  }

  // --- Collision: power-ups -> boost ---
  powerUps = powerUps.map((p) => {
    if (!p.collected && checkDinoCollision(dino, p, config)) {
      dino.isBoosted = true;
      dino.boostEndsAt = now + config.boostDurationMs;
      return { ...p, collected: true };
    }
    return p;
  });

  return {
    ...state,
    dino,
    obstacles,
    powerUps,
    worldX,
    nextObstacleId,
    nextPowerUpId,
    nextObstacleAt,
    nextPowerUpAt,
    rng,
  };
}

function obstacleDims(type: ObstacleType, config: GameConfig) {
  switch (type) {
    case "cactus-small":
      return { width: 20, height: 40, y: 0 };
    case "cactus-large":
      return { width: 30, height: 60, y: 0 };
    case "bird":
      // birds fly at one of two heights: low (duckable-under is wrong—
      // player must jump) or high (player must duck under)
      return { width: 46, height: 34, y: -60 };
  }
}

// Simple AABB collision, in a fixed player x-position (~80px from left,
// matching the classic dino game), with a little forgiveness padding.
function checkDinoCollision(
  dino: DinoState,
  obj: { x: number; y: number; width: number; height: number },
  config: GameConfig
): boolean {
  const PLAYER_X = 80;
  const PAD = 6; // forgiveness so near-misses don't feel unfair

  const dinoHeight = dino.isDucking ? config.duckHeight : config.dinoHeight;
  const dinoTop = dino.y - dinoHeight; // dino.y is 0 at ground, negative when jumping
  const dinoBottom = dino.y;
  const dinoLeft = PLAYER_X + PAD;
  const dinoRight = PLAYER_X + config.dinoWidth - PAD;

  const objTop = obj.y - obj.height;
  const objBottom = obj.y;
  const objLeft = obj.x + PAD;
  const objRight = obj.x + obj.width - PAD;

  const overlapsX = dinoRight > objLeft && dinoLeft < objRight;
  const overlapsY = dinoBottom > objTop && dinoTop < objBottom;

  return overlapsX && overlapsY;
}
