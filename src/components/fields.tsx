import type { ReactNode } from "react";
import { cx } from "./ui";

/**
 * Form controls. No hooks, so these render fine inside Server Components and
 * inside the client form wrapper alike.
 */

const CONTROL =
  "w-full rounded-lg border bg-[var(--bg-raised)] px-3 py-2 text-base text-[var(--text)] placeholder:text-[var(--text-faint)] transition-colors focus:border-[var(--accent)] disabled:opacity-60";

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx("block", className)}>
      <span className="mb-1 flex items-baseline gap-1.5">
        <span className="text-sm font-medium">{label}</span>
        {required ? (
          <span className="text-xs text-[var(--danger)]">required</span>
        ) : (
          <span className="text-xs text-[var(--text-faint)]">optional</span>
        )}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-xs text-[var(--text-faint)]">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span className="mt-1 block text-xs text-[var(--danger)]">{error}</span>
      ) : null}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(CONTROL, props.className)} />;
}

export function Textarea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  return (
    <textarea
      rows={3}
      {...props}
      className={cx(CONTROL, "resize-y", props.className)}
    />
  );
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx(CONTROL, "appearance-none pr-8", props.className)}>
      {props.children}
    </select>
  );
}

/** Money input. Always in rupees; the server converts to integer paise. */
export function RupeeInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-base text-[var(--text-faint)]">
        &#8377;
      </span>
      <input
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        {...props}
        className={cx(CONTROL, "tnum pl-7", props.className)}
      />
    </div>
  );
}

export function FieldRow({
  children,
  cols = 2,
}: {
  children: ReactNode;
  cols?: 1 | 2 | 3;
}) {
  return (
    <div
      className={cx(
        "grid gap-3",
        cols === 1 && "grid-cols-1",
        cols === 2 && "grid-cols-1 sm:grid-cols-2",
        cols === 3 && "grid-cols-1 sm:grid-cols-3",
      )}
    >
      {children}
    </div>
  );
}
