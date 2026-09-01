import "server-only";
import { prisma } from "@/lib/db";
import { env, isIndiamartEnabled } from "@/lib/env";
import { emptyTally, ingestLead, tally, type SyncTally } from "./common";

/**
 * IndiaMART Lead Manager CRM API v2.
 *
 * The provider rejects more than one call every five minutes per key, so the
 * rate limit is enforced on our side before a request is ever made. Two
 * things guard it:
 *
 *   - SyncState.lastRunAt, checked against INDIAMART_MIN_INTERVAL_MINUTES.
 *     A cron that fires early is told how long is left and no call goes out.
 *   - SyncState.lockedAt, taken with a conditional UPDATE, so two overlapping
 *     invocations cannot both get past the check.
 *
 * `lastRunAt` is stamped when the attempt starts, not when it succeeds. A
 * failed call still consumed the provider's allowance, so it still has to
 * hold the window.
 */

const SYNC_KEY = "indiamart";
/** A lock older than this is assumed to be from a crashed run. */
const LOCK_STALE_MS = 5 * 60 * 1000;

export type SyncStatus = "ok" | "skipped" | "disabled" | "locked" | "error";

export interface SyncOutcome {
  status: SyncStatus;
  message: string;
  tally: SyncTally;
  /** Seconds until the next call is allowed. Only set when status is skipped. */
  retryAfterSeconds?: number;
}

export interface IndiamartStatus {
  enabled: boolean;
  lastRunAt: Date | null;
  lastSuccessAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  fetched: number;
  created: number;
  duplicates: number;
  minIntervalMinutes: number;
  nextAllowedAt: Date | null;
  locked: boolean;
}

export async function getIndiamartStatus(orgId: string): Promise<IndiamartStatus> {
  const state = await prisma.syncState.findUnique({
    where: { orgId_key: { orgId, key: SYNC_KEY } },
  });
  const intervalMs = env.INDIAMART_MIN_INTERVAL_MINUTES * 60 * 1000;

  return {
    enabled: isIndiamartEnabled(),
    lastRunAt: state?.lastRunAt ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastStatus: state?.lastStatus ?? null,
    lastError: state?.lastError ?? null,
    fetched: state?.fetched ?? 0,
    created: state?.created ?? 0,
    duplicates: state?.duplicates ?? 0,
    minIntervalMinutes: env.INDIAMART_MIN_INTERVAL_MINUTES,
    nextAllowedAt: state?.lastRunAt
      ? new Date(state.lastRunAt.getTime() + intervalMs)
      : null,
    locked: Boolean(
      state?.lockedAt && Date.now() - state.lockedAt.getTime() < LOCK_STALE_MS,
    ),
  };
}

export async function syncIndiamart(orgId: string): Promise<SyncOutcome> {
  if (!isIndiamartEnabled()) {
    return {
      status: "disabled",
      message:
        "IndiaMART is switched off. Set INDIAMART_CRM_KEY to enable the pull.",
      tally: emptyTally(),
    };
  }

  const intervalMs = env.INDIAMART_MIN_INTERVAL_MINUTES * 60 * 1000;
  const now = new Date();

  await prisma.syncState.upsert({
    where: { orgId_key: { orgId, key: SYNC_KEY } },
    create: { orgId, key: SYNC_KEY },
    update: {},
  });

  const state = await prisma.syncState.findUniqueOrThrow({
    where: { orgId_key: { orgId, key: SYNC_KEY } },
  });

  // Never call early.
  if (state.lastRunAt && now.getTime() - state.lastRunAt.getTime() < intervalMs) {
    const remainingMs = intervalMs - (now.getTime() - state.lastRunAt.getTime());
    const seconds = Math.ceil(remainingMs / 1000);
    return {
      status: "skipped",
      message: `IndiaMART allows one call every ${env.INDIAMART_MIN_INTERVAL_MINUTES} minutes. Next call is allowed in ${formatWait(seconds)}.`,
      tally: emptyTally(),
      retryAfterSeconds: seconds,
    };
  }

  // Take the lock with a conditional update, the same trick the lead grab
  // uses: only one caller can see count === 1.
  const staleBefore = new Date(now.getTime() - LOCK_STALE_MS);
  const claimed = await prisma.syncState.updateMany({
    where: {
      orgId,
      key: SYNC_KEY,
      OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
    },
    data: { lockedAt: now, lastRunAt: now, lastStatus: "running", lastError: null },
  });

  if (claimed.count !== 1) {
    return {
      status: "locked",
      message: "An IndiaMART pull is already running.",
      tally: emptyTally(),
    };
  }

  const counts = emptyTally();

  try {
    const end = now;
    const start = new Date(
      now.getTime() - env.INDIAMART_LOOKBACK_MINUTES * 60 * 1000,
    );

    const records = await fetchIndiamart(start, end);

    for (const record of records) {
      const result = await ingestLead({
        orgId,
        source: "INDIAMART",
        externalId: str(record.UNIQUE_QUERY_ID),
        personName: str(record.SENDER_NAME) ?? "Unknown",
        phone: str(record.SENDER_MOBILE) ?? str(record.SENDER_MOBILE_ALT),
        email: str(record.SENDER_EMAIL) ?? str(record.SENDER_EMAIL_ALT),
        companyName: str(record.SENDER_COMPANY),
        city: str(record.SENDER_CITY),
        state: str(record.SENDER_STATE),
        product: str(record.QUERY_PRODUCT_NAME) ?? str(record.SUBJECT),
        message: str(record.QUERY_MESSAGE),
        receivedAt: parseIndiamartTime(str(record.QUERY_TIME)),
      });
      tally(result, counts);
    }

    await prisma.syncState.update({
      where: { orgId_key: { orgId, key: SYNC_KEY } },
      data: {
        lockedAt: null,
        lastSuccessAt: new Date(),
        lastStatus: "ok",
        lastError: null,
        fetched: counts.fetched,
        created: counts.created,
        duplicates: counts.duplicates,
      },
    });

    return {
      status: "ok",
      message: `Pulled ${counts.fetched} lead(s) from IndiaMART: ${counts.created} new, ${counts.duplicates} already known.`,
      tally: counts,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.syncState.update({
      where: { orgId_key: { orgId, key: SYNC_KEY } },
      data: { lockedAt: null, lastStatus: "error", lastError: message.slice(0, 500) },
    });
    return {
      status: "error",
      message: `IndiaMART pull failed: ${message}`,
      tally: counts,
    };
  }
}

// ---------------------------------------------------------------------------
// The provider call
// ---------------------------------------------------------------------------

interface IndiamartRecord {
  UNIQUE_QUERY_ID?: unknown;
  QUERY_TIME?: unknown;
  SENDER_NAME?: unknown;
  SENDER_MOBILE?: unknown;
  SENDER_MOBILE_ALT?: unknown;
  SENDER_EMAIL?: unknown;
  SENDER_EMAIL_ALT?: unknown;
  SENDER_COMPANY?: unknown;
  SENDER_CITY?: unknown;
  SENDER_STATE?: unknown;
  QUERY_PRODUCT_NAME?: unknown;
  QUERY_MESSAGE?: unknown;
  SUBJECT?: unknown;
}

async function fetchIndiamart(
  start: Date,
  end: Date,
): Promise<IndiamartRecord[]> {
  const url = new URL(env.INDIAMART_API_URL);
  url.searchParams.set("glusr_crm_key", env.INDIAMART_CRM_KEY);
  url.searchParams.set("start_time", indiamartTime(start));
  url.searchParams.set("end_time", indiamartTime(end));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.INDIAMART_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });

    if (response.status === 429) {
      throw new Error(
        "IndiaMART replied 429 Too Many Requests. The 5-minute window has not elapsed on their side.",
      );
    }
    if (!response.ok) {
      throw new Error(`IndiaMART replied ${response.status} ${response.statusText}`);
    }

    const body = (await response.json()) as {
      CODE?: number;
      STATUS?: string;
      MESSAGE?: string;
      RESPONSE?: unknown;
    };

    // The API answers 200 with an error code in the body.
    if (body.CODE && body.CODE !== 200) {
      throw new Error(
        `IndiaMART: ${body.MESSAGE ?? body.STATUS ?? `code ${body.CODE}`}`,
      );
    }

    if (!Array.isArray(body.RESPONSE)) return [];
    return body.RESPONSE as IndiamartRecord[];
  } finally {
    clearTimeout(timeout);
  }
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** IndiaMART wants dd-Mon-yyyyhh:mm:ss, e.g. 24-Aug-202609:30:00. */
function indiamartTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = pad(date.getUTCDate());
  const month = MONTHS[date.getUTCMonth()] ?? "Jan";
  const year = date.getUTCFullYear();
  return `${day}-${month}-${year}${pad(date.getUTCHours())}:${pad(
    date.getUTCMinutes(),
  )}:${pad(date.getUTCSeconds())}`;
}

/** Their QUERY_TIME comes back as "2026-08-24 09:30:00" in IST. */
function parseIndiamartTime(value: string | null): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim());
  if (!match) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  // IST is UTC+5:30 and has no DST.
  const asUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  return new Date(asUtc - 5.5 * 60 * 60 * 1000);
}

function str(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number") return String(value);
  return null;
}

function formatWait(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}
