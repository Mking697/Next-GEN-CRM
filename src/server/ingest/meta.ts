import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env, isMetaEnabled, metaWebhookUrl } from "@/lib/env";
import { emptyTally, ingestLead, tally, type SyncTally } from "./common";

/**
 * Meta (Facebook) Lead Ads.
 *
 * Meta pushes a notification, not the lead. The flow is:
 *
 *   1. GET  /api/webhooks/meta  -> answer the hub.challenge handshake once.
 *   2. POST /api/webhooks/meta  -> verify X-Hub-Signature-256 against the raw
 *      body using the app secret. An unverified body is discarded; without
 *      this anybody who learns the URL could inject leads.
 *   3. For each leadgen change, fetch the actual field values from the Graph
 *      API with the page access token.
 *
 * Meta retries on a non-2xx, so a single bad lead must not fail the whole
 * delivery. Each lead is handled independently and the route answers 200 as
 * long as the signature was good.
 */

export interface MetaStatus {
  enabled: boolean;
  callbackUrl: string;
  verifyTokenSet: boolean;
  pageTokenSet: boolean;
  graphVersion: string;
}

export function getMetaStatus(): MetaStatus {
  return {
    enabled: isMetaEnabled(),
    callbackUrl: metaWebhookUrl(),
    verifyTokenSet: env.META_VERIFY_TOKEN.length > 0,
    pageTokenSet: env.META_PAGE_ACCESS_TOKEN.length > 0,
    graphVersion: env.META_GRAPH_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/**
 * Constant-time check of the `X-Hub-Signature-256` header against the raw
 * request body. The body must be the exact bytes Meta sent: re-serialising
 * parsed JSON changes the digest.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  if (!isMetaEnabled()) return false;
  if (!signatureHeader) return false;

  const [algorithm, provided] = signatureHeader.split("=");
  if (algorithm !== "sha256" || !provided) return false;

  const expected = createHmac("sha256", env.META_APP_SECRET)
    .update(rawBody, "utf8")
    .digest("hex");

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The one-time GET handshake Meta performs when the webhook is registered. */
export function verifyHandshake(params: URLSearchParams): string | null {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode !== "subscribe" || !challenge) return null;
  if (!env.META_VERIFY_TOKEN || token !== env.META_VERIFY_TOKEN) return null;
  return challenge;
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

interface MetaWebhookPayload {
  object?: string;
  entry?: {
    id?: string;
    time?: number;
    changes?: {
      field?: string;
      value?: {
        leadgen_id?: string;
        form_id?: string;
        page_id?: string;
        created_time?: number;
      };
    }[];
  }[];
}

export interface MetaIngestResult {
  tally: SyncTally;
  errors: string[];
}

export async function handleMetaWebhook(
  payload: unknown,
): Promise<MetaIngestResult> {
  const counts = emptyTally();
  const errors: string[] = [];

  const body = payload as MetaWebhookPayload;
  if (body?.object !== "page" || !Array.isArray(body.entry)) {
    return { tally: counts, errors };
  }

  for (const entry of body.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen") continue;
      const leadgenId = change.value?.leadgen_id;
      if (!leadgenId) continue;

      try {
        const lead = await fetchLead(leadgenId);
        const result = await ingestLead({
          source: "META",
          externalId: leadgenId,
          personName: lead.personName,
          phone: lead.phone,
          email: lead.email,
          companyName: lead.companyName,
          city: lead.city,
          state: lead.state,
          product: lead.product,
          message: lead.message,
          receivedAt: lead.createdAt,
        });
        tally(result, counts);
      } catch (error) {
        // One bad lead must not make Meta retry the whole delivery.
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${leadgenId}: ${message}`);
        console.error("[meta] lead fetch failed", leadgenId, message);
      }
    }
  }

  return { tally: counts, errors };
}

// ---------------------------------------------------------------------------
// Graph API
// ---------------------------------------------------------------------------

interface NormalisedLead {
  personName: string;
  phone: string | null;
  email: string | null;
  companyName: string | null;
  city: string | null;
  state: string | null;
  product: string | null;
  message: string | null;
  createdAt: Date | null;
}

async function fetchLead(leadgenId: string): Promise<NormalisedLead> {
  if (!env.META_PAGE_ACCESS_TOKEN) {
    throw new Error("META_PAGE_ACCESS_TOKEN is not set, so lead fields cannot be fetched.");
  }

  const url = new URL(
    `/${env.META_GRAPH_VERSION}/${encodeURIComponent(leadgenId)}`,
    env.META_GRAPH_URL,
  );
  url.searchParams.set("access_token", env.META_PAGE_ACCESS_TOKEN);
  url.searchParams.set("fields", "id,created_time,field_data,ad_name,campaign_name,form_id");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.META_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });

    const body = (await response.json()) as {
      error?: { message?: string };
      created_time?: string;
      ad_name?: string;
      campaign_name?: string;
      field_data?: { name?: string; values?: string[] }[];
    };

    if (!response.ok || body.error) {
      throw new Error(body.error?.message ?? `Graph API replied ${response.status}`);
    }

    return normalise(body);
  } finally {
    clearTimeout(timeout);
  }
}

/** Lead form field names are chosen by whoever built the form. */
const FIELD_ALIASES: Record<keyof Omit<NormalisedLead, "createdAt">, string[]> = {
  personName: ["full_name", "name", "first_name", "your_name", "full name"],
  phone: ["phone_number", "phone", "mobile", "mobile_number", "contact_number"],
  email: ["email", "email_address", "work_email"],
  companyName: ["company_name", "company", "organisation", "organization", "business_name"],
  city: ["city", "town", "city_name"],
  state: ["state", "province", "region"],
  product: ["product", "product_interest", "service", "interested_in"],
  message: ["message", "comments", "requirement", "details", "note"],
};

function normalise(body: {
  created_time?: string;
  ad_name?: string;
  campaign_name?: string;
  field_data?: { name?: string; values?: string[] }[];
}): NormalisedLead {
  const map = new Map<string, string>();
  for (const field of body.field_data ?? []) {
    const name = field.name?.trim().toLowerCase();
    const value = field.values?.find((v) => typeof v === "string" && v.trim().length > 0);
    if (name && value) map.set(name, value.trim());
  }

  const pick = (key: keyof typeof FIELD_ALIASES): string | null => {
    for (const alias of FIELD_ALIASES[key]) {
      const found = map.get(alias);
      if (found) return found;
    }
    return null;
  };

  // A first_name / last_name pair is common.
  let personName = pick("personName");
  if (!personName) {
    const first = map.get("first_name");
    const last = map.get("last_name");
    personName = [first, last].filter(Boolean).join(" ") || null;
  }

  const created = body.created_time ? new Date(body.created_time) : null;

  return {
    personName: personName ?? "Facebook lead",
    phone: pick("phone"),
    email: pick("email"),
    companyName: pick("companyName"),
    city: pick("city"),
    state: pick("state"),
    product: pick("product") ?? body.ad_name ?? body.campaign_name ?? null,
    message: pick("message"),
    createdAt: created && !Number.isNaN(created.getTime()) ? created : null,
  };
}
