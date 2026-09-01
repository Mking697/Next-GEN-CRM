import "server-only";

/**
 * A fixed-window counter held in process memory.
 *
 * This app is deliberately one Node process on one port, so a shared store
 * would be a dependency bought for nothing. If it is ever scaled to more than
 * one instance this needs to move to the database or a cache; the interface
 * is small enough that the swap is contained.
 *
 * Used only to blunt password guessing. It is not a billing meter.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();
let lastSweep = 0;

function sweep(now: number): void {
  // Amortised cleanup, at most once a minute.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function hit(
  key: string,
  limit: number,
  windowMinutes: number,
): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMinutes * 60_000 });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  const allowed = existing.count <= limit;
  return {
    allowed,
    remaining: Math.max(0, limit - existing.count),
    retryAfterSeconds: allowed
      ? 0
      : Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

/** Called after a success, so a good password clears the counter. */
export function reset(key: string): void {
  windows.delete(key);
}
