import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RaRRcord",
  description: "Private community messaging, voice, and screen sharing.",
  icons: { icon: "/favicon.svg", apple: "/favicon.svg" },
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
