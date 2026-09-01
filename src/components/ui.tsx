import type { ReactNode } from "react";
import Link from "next/link";

/**
 * Small presentational primitives shared across the pages. Server-safe: no
 * hooks, no event handlers, so any of these can render inside a Server
 * Component without pulling the page into the client bundle.
 */

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={cx(
        "rounded-xl border bg-[var(--bg-raised)] shadow-[var(--shadow-sm)]",
        // One token, so card density is a single edit rather than an audit.
        padded && "p-[var(--pad-card)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  hint,
  action,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-md font-semibold tracking-tight">{title}</h2>
        {hint ? (
          <p className="mt-0.5 text-base text-[var(--text-muted)]">{hint}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {subtitle ? (
          <p className="mt-1 max-w-2xl text-base text-[var(--text-muted)]">
            {subtitle}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

// ---------------------------------------------------------------------------

type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

const TONE_CLASS: Record<Tone, string> = {
  neutral: "bg-[var(--bg-sunken)] text-[var(--text-muted)] border-[var(--border)]",
  accent: "bg-[var(--accent-soft)] text-[var(--accent-text)] border-transparent",
  ok: "bg-[var(--ok-soft)] text-[var(--ok)] border-transparent",
  warn: "bg-[var(--warn-soft)] text-[var(--warn)] border-transparent",
  danger: "bg-[var(--danger-soft)] text-[var(--danger)] border-transparent",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------

/**
 * `sub` is a second figure on the same tile.
 *
 * The Overview was nine tiles - five lead counts and four money ones - which
 * pushed the by-salesman table, the thing people actually came for, below the
 * fold. Pairing the related figures gets it back above it.
 */
export function StatTile({
  label,
  value,
  sub,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  hint?: string;
  tone?: Tone;
}) {
  const accent =
    tone === "ok"
      ? "text-[var(--ok)]"
      : tone === "warn"
        ? "text-[var(--warn)]"
        : tone === "danger"
          ? "text-[var(--danger)]"
          : tone === "accent"
            ? "text-[var(--accent-text)]"
            : "";

  return (
    <div className="rounded-xl border bg-[var(--bg-raised)] p-3 shadow-[var(--shadow-sm)]">
      <div className="text-xs font-medium tracking-wide text-[var(--text-faint)] uppercase">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className={cx("tnum text-xl font-semibold tracking-tight", accent)}>
          {value}
        </span>
        {sub ? (
          <span className="tnum text-sm text-[var(--text-muted)]">{sub}</span>
        ) : null}
      </div>
      {hint ? (
        <div className="mt-1 text-xs leading-snug text-[var(--text-faint)]">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed bg-[var(--bg-sunken)] px-6 py-12 text-center">
      <p className="text-md font-medium">{title}</p>
      {body ? (
        <p className="mx-auto mt-1.5 max-w-md text-base text-[var(--text-muted)]">
          {body}
        </p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Notice({
  tone = "neutral",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  const border =
    tone === "danger"
      ? "border-[var(--danger)]"
      : tone === "warn"
        ? "border-[var(--warn)]"
        : tone === "ok"
          ? "border-[var(--ok)]"
          : "border-[var(--border-strong)]";

  return (
    <div
      className={cx(
        "rounded-lg border-l-2 bg-[var(--bg-sunken)] px-3.5 py-2.5 text-base",
        border,
      )}
      role={tone === "danger" ? "alert" : undefined}
    >
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={cx(title && "mt-0.5", "text-[var(--text-muted)]")}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * The data-table shell.
 *
 * `crm-table` is what carries row hover and focus-within from globals.css.
 * Every page writes its own <tr>, so attaching the behaviour to the one
 * element they all share beats editing eight files.
 *
 * `sticky` keeps the header visible while the body scrolls, which is what a
 * 25-row list needs: without it you are three columns in and guessing which
 * one you are reading.
 */
export function Table({
  children,
  sticky = false,
  minWidth = "42rem",
}: {
  children: ReactNode;
  sticky?: boolean;
  minWidth?: string;
}) {
  return (
    <div
      className={cx(
        "scroll-x -mx-[var(--pad-card)] px-[var(--pad-card)]",
        sticky && "max-h-[70vh] overflow-y-auto",
      )}
    >
      <table
        className={cx(
          "crm-table w-full border-collapse text-sm",
          sticky && "crm-table--sticky",
        )}
        style={{ minWidth }}
      >
        {children}
      </table>
    </div>
  );
}

export function Th({
  children,
  align = "left",
  className,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
}) {
  return (
    <th
      className={cx(
        "border-b px-2 py-1.5 text-xs font-medium tracking-wide text-[var(--text-faint)] uppercase",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
        className,
      )}
      scope="col"
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  align = "left",
  className,
  numeric = false,
}: {
  children?: ReactNode;
  align?: "left" | "right" | "center";
  className?: string;
  numeric?: boolean;
}) {
  return (
    <td
      className={cx(
        // py-2.5 gave a ~34px row at 13px text. --row-py brings it to ~29px,
        // which is a whole extra row visible in a 25-row list.
        "border-b px-2 py-[var(--row-py)] align-middle",
        align === "right" && "text-right",
        align === "center" && "text-center",
        numeric && "tnum",
        className,
      )}
    >
      {children}
    </td>
  );
}

// ---------------------------------------------------------------------------
// Links and buttons that are just links
// ---------------------------------------------------------------------------

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-base font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55";

export const buttonStyles = {
  base: BUTTON_BASE,
  primary: cx(
    BUTTON_BASE,
    "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]",
  ),
  secondary: cx(
    BUTTON_BASE,
    "border bg-[var(--bg-raised)] hover:bg-[var(--bg-hover)]",
  ),
  ghost: cx(BUTTON_BASE, "text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"),
  danger: cx(
    BUTTON_BASE,
    "border border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger-soft)]",
  ),
};

export function LinkButton({
  href,
  children,
  variant = "secondary",
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: keyof typeof buttonStyles;
  className?: string;
}) {
  return (
    <Link href={href} className={cx(buttonStyles[variant], className)}>
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------

export function DefinitionRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3 border-b py-2 last:border-0">
      <dt className="w-32 shrink-0 text-sm text-[var(--text-faint)]">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}

/** A thin progress bar for received-against-order. */
export function Meter({ percent, tone = "accent" }: { percent: number; tone?: Tone }) {
  const width = Math.max(0, Math.min(100, percent));
  const fill =
    tone === "ok"
      ? "bg-[var(--ok)]"
      : tone === "warn"
        ? "bg-[var(--warn)]"
        : "bg-[var(--accent)]";

  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-sunken)]"
      role="img"
      aria-label={`${width}% received`}
    >
      <div className={cx("h-full rounded-full", fill)} style={{ width: `${width}%` }} />
    </div>
  );
}
