export const metadata = {
  title: "Dino Multiplayer",
  description: "A multiplayer take on the Chrome dino game",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
