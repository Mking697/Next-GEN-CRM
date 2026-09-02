import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Next Gen CRM",
    template: "%s - Next Gen CRM",
  },
  description:
    "Lead pool, orders and collections for a sales team working IndiaMART, Meta and walk-in enquiries.",
  /*
   * Off by default, and turned back on by the landing page alone.
   *
   * Every other route is somebody's working data behind a sign-in and has no
   * business in an index. The front page is the one surface meant to be
   * found, so it overrides this - rather than the whole app becoming
   * indexable to let one page in.
   */
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f7f8fb" },
    { media: "(prefers-color-scheme: dark)", color: "#151823" },
  ],
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
