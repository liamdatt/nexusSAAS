import type { Metadata } from "next";
import { Orbitron, Roboto_Mono, Inter } from "next/font/google"; // Import standard Inter as well for body
import "./globals.css";

const orbitron = Orbitron({
  subsets: ["latin"],
  variable: "--font-orbitron",
  display: "swap",
});

const robotoMono = Roboto_Mono({
  subsets: ["latin"],
  variable: "--font-roboto",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "NEXUS | CONTROL",
  description: "Advanced Agentic Interface",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${orbitron.variable} ${robotoMono.variable} ${inter.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
