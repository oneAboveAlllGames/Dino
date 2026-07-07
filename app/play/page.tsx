"use client";

// app/play/page.tsx
//
// Solo test harness — just proves out the engine + rendering before we add
// the Supabase Realtime layer on top. Space/Up = jump, Down = duck.

import DinoCanvas from "../../components/DinoCanvas";

export default function PlayPage() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Dino Engine Test</h1>
      <p>Space / ↑ to jump, ↓ to duck. Hitting an obstacle stumbles you for 2s (no death). Orange dots are speed boosts.</p>
      <DinoCanvas seed={42} distanceGoal={5000} onFinish={() => alert("Finish line!")} />
    </main>
  );
}
