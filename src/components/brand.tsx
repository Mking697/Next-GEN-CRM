import { cx } from "./ui";

/**
 * The product's own identity, shown at every entry point: the sidebar, and
 * the login and signup screens. One place, so the mark and the name can never
 * drift between them.
 */

const PRODUCT_NAME = "Next Gen CRM";

export function Brandmark({
  size = "md",
  className,
}: {
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex items-center justify-center rounded-lg bg-[var(--accent)] font-semibold text-white",
        size === "sm" ? "h-7 w-7 rounded-md text-sm" : "h-9 w-9 text-base",
        className,
      )}
      aria-hidden
    >
      NG
    </div>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx("font-semibold tracking-tight", className)}>
      {PRODUCT_NAME}
    </span>
  );
}

/** Mark and name together, the way the sidebar and the auth screens both want it. */
export function Brand({
  size = "md",
  className,
}: {
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <div className={cx("flex items-center gap-2.5", className)}>
      <Brandmark size={size} />
      <Wordmark className={size === "sm" ? "text-md" : "text-lg"} />
    </div>
  );
}
