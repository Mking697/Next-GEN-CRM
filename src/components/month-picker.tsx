"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/**
 * The month control at the top of the Overview. Writes the choice into the
 * query string, so every figure below re-renders on the server for that
 * month and the URL stays shareable.
 */
export function MonthPicker({
  months,
  value,
}: {
  months: { key: string; label: string }[];
  value: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  const go = (month: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("month", month);
    startTransition(() => router.push(`${pathname}?${params.toString()}`));
  };

  const index = months.findIndex((month) => month.key === value);
  const older = index >= 0 && index < months.length - 1 ? months[index + 1] : null;
  const newer = index > 0 ? months[index - 1] : null;

  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border bg-[var(--bg-raised)] p-1"
      aria-busy={pending || undefined}
    >
      <button
        type="button"
        onClick={() => older && go(older.key)}
        disabled={!older || pending}
        aria-label={older ? `Go to ${older.label}` : "No earlier month"}
        className="rounded-md px-2 py-1 text-base text-[var(--text-muted)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
      >
        &#8592;
      </button>

      <select
        value={value}
        onChange={(event) => go(event.target.value)}
        disabled={pending}
        aria-label="Month"
        className="min-w-[9.5rem] rounded-md bg-transparent px-2 py-1 text-base font-medium"
      >
        {months.map((month) => (
          <option key={month.key} value={month.key}>
            {month.label}
          </option>
        ))}
      </select>

      <button
        type="button"
        onClick={() => newer && go(newer.key)}
        disabled={!newer || pending}
        aria-label={newer ? `Go to ${newer.label}` : "No later month"}
        className="rounded-md px-2 py-1 text-base text-[var(--text-muted)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
      >
        &#8594;
      </button>
    </div>
  );
}
