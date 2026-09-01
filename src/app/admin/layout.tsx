import type { Metadata } from "next";

export const metadata: Metadata = { title: { default: "Platform", template: "%s - Platform" } };

/**
 * The console has its own shell.
 *
 * Not the dashboard layout: that one requires a CRM session in an
 * organisation, and a platform administrator has neither. Keeping the two
 * surfaces apart is the whole design - nothing here can accidentally be
 * handed a tenant-scoped helper, and nothing in the CRM knows this exists.
 */
export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-[var(--bg)]">{children}</div>;
}
