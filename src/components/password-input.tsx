"use client";

import { useId, useState } from "react";
import { cx } from "./ui";

/**
 * A password field you can look at.
 *
 * Separate from fields.tsx on purpose: that file is deliberately hook-free so
 * it renders inside Server Components, and a toggle needs state. Keeping the
 * one stateful control here means the rest of the form kit stays server-safe.
 *
 * Worth having rather than a nicety. People mistype long passwords, and the
 * alternative to seeing it is guessing at eight dots and trying again - which
 * on the sign-in screen means a wasted attempt against the rate limiter.
 */
export function PasswordInput({
  className,
  initiallyVisible = false,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & {
  /**
   * Start showing rather than hidden.
   *
   * For the one field that exists to be read: the suggested password on the
   * create-account form, which an admin has to pass on to the person it
   * belongs to. Masking that by default would mean revealing it every single
   * time. The toggle is still there for when somebody is standing behind you.
   */
  initiallyVisible?: boolean;
}) {
  const [visible, setVisible] = useState(initiallyVisible);
  const describedBy = useId();

  return (
    <span className="relative block">
      <input
        {...props}
        type={visible ? "text" : "password"}
        aria-describedby={describedBy}
        className={cx(
          "w-full rounded-lg border bg-[var(--bg-raised)] py-2 pl-3 text-base text-[var(--text)] placeholder:text-[var(--text-faint)] transition-colors focus:border-[var(--accent)] disabled:opacity-60",
          // Room for the button, so a long password never runs underneath it.
          "pr-11",
          className,
        )}
      />

      <button
        type="button"
        onClick={() => setVisible((shown) => !shown)}
        // The label says what pressing it DOES, which is what a screen reader
        // announces. aria-pressed carries the current state separately.
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        // Not focusable by Tab: it sits between the field and the submit
        // button, and stopping there on the way to signing in is friction for
        // everybody in order to help the few who want it. Still reachable by
        // click, tap and screen reader.
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex w-11 cursor-pointer items-center justify-center rounded-r-lg text-[var(--text-faint)] transition-colors hover:text-[var(--text)]"
      >
        {visible ? <EyeOff /> : <Eye />}
      </button>

      <span id={describedBy} className="sr-only">
        {visible ? "Password is showing" : "Password is hidden"}
      </span>
    </span>
  );
}

/*
 * Drawn here at the same 1.5 stroke as the rest of the application's icons,
 * rather than pulling in an icon package for two glyphs.
 */
const svg = {
  width: 17,
  height: 17,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function Eye() {
  return (
    <svg {...svg}>
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg {...svg}>
      <path d="M10.6 6.1A9.9 9.9 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a17.7 17.7 0 0 1-3.1 4M6.2 8.3A17.4 17.4 0 0 0 2 12s3.5 6.5 10 6.5a9.8 9.8 0 0 0 4-.85" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="m3 3 18 18" />
    </svg>
  );
}
