import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Harness Dashboard",
  description: "Local view of Harness activity",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
