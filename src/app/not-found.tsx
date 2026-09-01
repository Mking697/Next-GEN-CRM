import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 text-center">
      <div>
        <p className="text-base font-medium tracking-wide text-[var(--text-faint)] uppercase">
          Not found
        </p>
        <h1 className="mt-2 text-lg font-semibold tracking-tight">
          That page does not exist, or it is not yours to see
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-base text-[var(--text-muted)]">
          A lead or an order outside your scope looks exactly the same as one
          that was never there. That is deliberate.
        </p>
        <Link
          href="/overview"
          className="mt-5 inline-flex rounded-lg bg-[var(--accent)] px-3 py-1.5 text-base font-medium text-white hover:bg-[var(--accent-hover)]"
        >
          Back to the overview
        </Link>
      </div>
    </main>
  );
}
