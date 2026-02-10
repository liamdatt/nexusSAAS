import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nexus SaaS Control",
  description: "Control and monitor Nexus tenants",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
