import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import {
  PERMISSIONS,
  ROLE_LABEL,
  type PermissionDef,
  type PermissionId,
} from "@/lib/permissions";

export const metadata: Metadata = { title: "Not allowed" };

/**
 * Where requirePageAccess() sends somebody who is signed in but not permitted.
 * The explanation is read out of the same permission row that refused them,
 * so it always names the real reason.
 */
export default async function DeniedPage({
  searchParams,
}: {
  searchParams: Promise<{ permission?: string }>;
}) {
  const user = await requireUser();
  const { permission } = await searchParams;

  const known =
    permission && permission in PERMISSIONS
      ? (PERMISSIONS[permission as PermissionId] as PermissionDef)
      : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg items-center px-5">
      <div>
        <p className="text-xs font-medium tracking-wide text-[var(--text-faint)] uppercase">
          Not allowed
        </p>
        <h1 className="mt-2 text-lg font-semibold tracking-tight">
          {known
            ? `A ${ROLE_LABEL[user.role]} cannot ${known.title.toLowerCase()}`
            : "That page is not open to your role"}
        </h1>

        {known ? (
          <p className="mt-2 text-base leading-relaxed text-[var(--text-muted)]">
            {known.detail}
          </p>
        ) : null}

        <p className="mt-3 text-base text-[var(--text-muted)]">
          Your guidebook lists everything a {ROLE_LABEL[user.role]} account can
          do, and everything it cannot.
        </p>

        <div className="mt-5 flex gap-2">
          <Link
            href="/guidebook"
            className="rounded-lg bg-[var(--accent)] px-3 py-1.5 text-base font-medium text-white hover:bg-[var(--accent-hover)]"
          >
            Open the guidebook
          </Link>
          <Link
            href="/overview"
            className="rounded-lg border px-3 py-1.5 text-base font-medium hover:bg-[var(--bg-hover)]"
          >
            Back to the overview
          </Link>
        </div>
      </div>
    </main>
  );
}
