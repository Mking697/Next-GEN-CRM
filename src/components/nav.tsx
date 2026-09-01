"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { setActingSalesmanAction } from "@/actions/users";
import { cx } from "./ui";

export interface NavItem {
  href: string;
  label: string;
  /** Rendered as a count pill, e.g. how many leads are waiting in the pool. */
  badge?: number;
}

/**
 * The sidebar. Which links exist is decided on the server from the permission
 * table, so this component never has to know what a role may do; it only
 * highlights whichever links it was handed.
 */
export function Nav({
  items,
  user,
  acting,
}: {
  items: NavItem[];
  user: { name: string; role: string; email: string };
  /**
   * For a CRE working for more than one salesman: who they can work as, and
   * who they are working as now. Null when there is no choice to make.
   */
  acting?: {
    options: { id: string; name: string }[];
    activeId: string | null;
  } | null;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="fixed top-3 left-3 z-30 rounded-lg border bg-[var(--bg-raised)] px-2.5 py-1.5 text-base shadow-[var(--shadow-sm)] lg:hidden"
        aria-expanded={open}
        aria-controls="sidebar"
      >
        {open ? "Close" : "Menu"}
      </button>

      {open ? (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-20 bg-black/30 lg:hidden"
        />
      ) : null}

      <aside
        id="sidebar"
        className={cx(
          "fixed inset-y-0 left-0 z-20 flex w-60 flex-col border-r bg-[var(--bg-raised)] transition-transform lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center gap-2.5 border-b px-4 py-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent)] text-base font-semibold text-white">
            C
          </div>
          <span className="text-md font-semibold tracking-tight">Sales CRM</span>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
          {items.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-base transition-colors",
                  active
                    ? "bg-[var(--accent-soft)] font-medium text-[var(--accent-text)]"
                    : "text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]",
                )}
              >
                <span>{item.label}</span>
                {item.badge && item.badge > 0 ? (
                  <span
                    className={cx(
                      "tnum rounded-full px-1.5 py-0.5 text-xs font-medium",
                      active
                        ? "bg-[var(--accent)] text-white"
                        : "bg-[var(--bg-sunken)] text-[var(--text-muted)]",
                    )}
                  >
                    {item.badge > 99 ? "99+" : item.badge}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>

        {acting ? (
          <div className="border-t px-3 py-2.5">
            <label
              htmlFor="acting-salesman"
              className="block text-xs font-medium text-[var(--text-faint)]"
            >
              Working as
            </label>
            {/* A plain form that submits on change: switching salesman
                changes what every list below is scoped to, so it has to be a
                round trip to the server, not client state. */}
            <form action={setActingSalesmanAction}>
              <select
                id="acting-salesman"
                name="salesmanId"
                defaultValue={acting.activeId ?? ""}
                onChange={(event) => event.currentTarget.form?.requestSubmit()}
                className="mt-1 w-full rounded-lg border bg-[var(--bg-raised)] px-2 py-1.5 text-base"
              >
                {acting.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </form>
          </div>
        ) : null}

        <div className="border-t p-3">
          <Link
            href="/account"
            onClick={() => setOpen(false)}
            className="block rounded-lg px-3 py-2 hover:bg-[var(--bg-hover)]"
          >
            <div className="truncate text-base font-medium">{user.name}</div>
            <div className="truncate text-xs text-[var(--text-faint)]">
              {user.role}
            </div>
          </Link>
        </div>
      </aside>
    </>
  );
}
