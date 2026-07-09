import type { Metadata, Viewport } from "next";
import { Geist, Fragment_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

// One latin sans (Geist) for both UI and prose — Inter was a second, overlapping
// latin sans and shipped a redundant font payload (perf M3). Fragment Mono stays
// for code.
const geist = Geist({
  variable: "--font-geist",
  subsets: ["latin"],
});

const fragmentMono = Fragment_Mono({
  variable: "--font-mono",
  weight: "400",
  subsets: ["latin"],
});

// Warm the Supabase origin so the realtime websocket does not pay cold
// DNS+TCP+TLS after hydration (perf L1). dns-prefetch is the fallback for
// engines that ignore preconnect.
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

export const metadata: Metadata = {
  title: "md.jholec.com",
  description:
    "Host a Markdown file, share a link, and collect inline feedback pinned to the exact words, no install required.",
};

// Without an explicit viewport export, Next emits its default `width=device-width,
// initial-scale=1` WITHOUT `viewport-fit=cover`, so every env(safe-area-inset-*)
// resolves to 0 on notched iOS and content can sit under the notch/home indicator
// (M18). `viewport-fit: cover` opts the page into the full display and makes the
// safe-area insets non-zero. We deliberately DO NOT set maximumScale /
// userScalable — pinch-zoom must stay available (WCAG 1.4.4).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geist.variable} ${fragmentMono.variable} h-full antialiased`}
    >
      <head>
        {supabaseUrl ? (
          <>
            <link rel="preconnect" href={supabaseUrl} crossOrigin="anonymous" />
            <link rel="dns-prefetch" href={supabaseUrl} />
          </>
        ) : null}
      </head>
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
