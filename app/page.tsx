import Link from "next/link";

export default function Home() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Dino Multiplayer</h1>
      <p>
        <Link href="/play">Go to the solo test page →</Link>
      </p>
      <p>
        <Link href="/multiplayer">Play online multiplayer →</Link>
      </p>
    </main>
  );
}
