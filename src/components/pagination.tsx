import Link from "next/link";

export function Pagination({
  page,
  pageCount,
  total,
  base,
  params,
}: {
  page: number;
  pageCount: number;
  total: number;
  base: string;
  params: Record<string, string | undefined>;
}) {
  if (pageCount <= 1) return null;

  const link = (target: number) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value && key !== "page") search.set(key, value);
    }
    search.set("page", String(target));
    return `${base}?${search.toString()}`;
  };

  return (
    <nav
      className="mt-3 flex items-center justify-between text-sm text-[var(--text-muted)]"
      aria-label="Pagination"
    >
      <span className="tnum">
        Page {page} of {pageCount} &middot; {total} total
      </span>
      <span className="flex gap-3">
        {page > 1 ? (
          <Link href={link(page - 1)} className="hover:text-[var(--accent-text)]">
            Previous
          </Link>
        ) : null}
        {page < pageCount ? (
          <Link href={link(page + 1)} className="hover:text-[var(--accent-text)]">
            Next
          </Link>
        ) : null}
      </span>
    </nav>
  );
}
