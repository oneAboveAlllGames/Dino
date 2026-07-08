// lib/types.ts

export type ObstacleType = "cactus-small" | "cactus-large" | "bird";

export interface Obstacle {
  id: number;
  type: ObstacleType;
  x: number;       // world x position (px)
  y: number;       // ground-relative y offset (birds fly higher)
  width: number;
  height: number;
  hit?: boolean;   // once true, this obstacle can no longer trigger a stumble —
                   // the player passes through it for the rest of its lifetime
}

export interface PowerUp {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  collected: boolean;
}

export type DinoAction = "run" | "jump" | "duck" | "stumble";

export interface DinoState {
  y: number;            // vertical position (0 = ground)
  velocityY: number;
  isJumping: boolean;
  isDucking: boolean;
  isStumbling: boolean;
  stumbleEndsAt: number | null; // timestamp (ms) when stumble ends
  isBoosted: boolean;
  boostEndsAt: number | null;
  distance: number;     // total distance traveled (score)
  speed: number;         // current forward speed (px/frame at 60fps baseline)
}

export interface GameConfig {
  seed: number;
  groundY: number;
  baseSpeed: number;
  maxSpeed: number;
  gravity: number;
  jumpVelocity: number;
  duckHeight: number;
  dinoWidth: number;
  dinoHeight: number;
  stumbleDurationMs: number;
  boostDurationMs: number;
  boostMultiplier: number;
  obstacleMinGapPx: number;
  obstacleMaxGapPx: number;
  // Boosts are now spawned on a fixed schedule spread evenly across the
  // race's actual TIME (not distance) — e.g. a fixed count of boosts for a
  // 1.5/2/3 min race, appearing at regular intervals regardless of how far
  // any given player has traveled. This replaces the old random
  // distance-based spawn interval.
  boostCount: number;
  raceDurationMs: number;
}

export interface RemotePlayerState {
  playerId: string;
  playerName: string;
  distance: number;
  y: number;
  isDucking: boolean;
  isStumbling: boolean;
  isBoosted: boolean;
  finished: boolean;
  updatedAt: number;
}