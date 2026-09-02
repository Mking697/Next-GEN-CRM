import "server-only";
import { z } from "zod";

/**
 * Every setting in this app comes from an environment variable. Nothing here
 * has a hardcoded URL, key or secret.
 *
 * Parsing is lazy and memoised on purpose. `next build` imports every module
 * but renders nothing that touches the database (every page reads cookies, so
 * every page is dynamic), which means a build machine does not need production
 * secrets. The first real request is what forces validation, and a missing
 * variable fails loudly there with the variable named.
 */

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  APP_URL: z
    .string()
    .url("APP_URL must be an absolute URL, e.g. https://crm.example.com")
    .transform((v) => v.replace(/\/+$/, "")),
  APP_TIMEZONE: z.string().min(1).default("Asia/Kolkata"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL (pooled Neon URL) is required"),
  DIRECT_DATABASE_URL: z
    .string()
    .min(1, "DIRECT_DATABASE_URL (unpooled Neon URL) is required"),
  /*
   * Sized for the concurrency, not for the size of the database.
   *
   * The Overview costs about seventeen round-trips, so ten people opening it
   * at once is a hundred and seventy queries. At a pool of 10 that is
   * seventeen waves of network latency; at 25 it is seven. Measured against
   * the real data, ten concurrent Overview loads went from 1417ms to 1032ms
   * and twenty from 2596ms to 1534ms.
   *
   * The app talks to Neon through its pooler, which handles thousands of
   * client connections, so 25 from one Node process costs nothing there.
   */
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(25),
  DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 characters"),
  SESSION_COOKIE_NAME: z.string().min(1).default("crm_session"),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(168),
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),

  CRON_SECRET: z.string().default(""),

  /**
   * The workspace slug that owns the IndiaMART and Meta credentials below.
   *
   * Those are still process-wide environment variables, which means they can
   * only ever belong to ONE organisation - one CRM key fetches one seller's
   * enquiries. Naming that organisation is the honest way to say so; feeding
   * one seller's leads into every workspace would be the alternative.
   *
   * This goes away when integration credentials move into the database per
   * organisation, at which point the cron iterates organisations instead.
   */
  INTEGRATIONS_ORG_SLUG: z.string().default(""),

  INDIAMART_CRM_KEY: z.string().default(""),
  INDIAMART_API_URL: z
    .string()
    .url()
    .default("https://mapi.indiamart.com/wservce/crm/crmListing/v2/"),
  INDIAMART_MIN_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(5),
  INDIAMART_LOOKBACK_MINUTES: z.coerce.number().int().positive().default(30),
  INDIAMART_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),

  META_APP_SECRET: z.string().default(""),
  META_VERIFY_TOKEN: z.string().default(""),
  META_PAGE_ACCESS_TOKEN: z.string().default(""),

  META_GRAPH_VERSION: z.string().default("v21.0"),
  META_GRAPH_URL: z.string().url().default("https://graph.facebook.com"),
  META_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  DODO_PAYMENTS_API_KEY: z.string().default(""),
  DODO_PAYMENTS_WEBHOOK_SECRET: z.string().default(""),
  /**
   * The subscription product created once in the Dodo Payments dashboard.
   * There are no plan tiers - every workspace renews against this one
   * product, and Dodo Payments prices it, not this app: nothing here stores a
   * rupee amount to bill, so it cannot drift from what the dashboard actually
   * charges.
   */
  DODO_PAYMENTS_PRODUCT_ID: z.string().default(""),
  DODO_PAYMENTS_MODE: z.enum(["test", "live"]).default("test"),
}).superRefine((value, ctx) => {
  // The session cookie takes its Secure flag from APP_URL, because that is
  // the only thing that knows whether the public origin is TLS - the app
  // itself sits behind a proxy and only ever sees plain http. A wrong value
  // here would silently ship every session cookie without Secure, so a
  // non-local origin has to be https or the app refuses to start.
  //
  // Keyed on the host rather than on NODE_ENV deliberately. A hosting panel
  // that never sets NODE_ENV leaves it defaulting to "development", which
  // would switch this check off in exactly the deployment it exists for.
  if (!value.APP_URL.startsWith("https://") && !isLocalOrigin(value.APP_URL)) {
    ctx.addIssue({
      code: "custom",
      path: ["APP_URL"],
      message:
        `APP_URL is ${value.APP_URL}, which is not https and not a local address. ` +
        "The session cookie takes its Secure flag from this value, so starting " +
        "like this would send every session cookie in the clear. Set the public " +
        "https origin, e.g. https://crm.example.com.",
    });
  }
});

/**
 * Where plain http is a normal thing to be running on: the dev machine, and
 * a private LAN address while testing on a phone.
 */
function isLocalOrigin(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "127.0.0.1" || host === "::1" || host === "[::1]") return true;
  // RFC1918.
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return false;
}

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

function parseEnv(): Env {
  // Strip empty strings so zod defaults apply to blank panel fields.
  const raw: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && value.length > 0) raw[key] = value;
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
    );
    throw new Error(
      [
        "Invalid environment configuration.",
        ...lines,
        "",
        "See .env.example for what each variable means.",
      ].join("\n"),
    );
  }
  return result.data;
}

/**
 * Lazily validated environment. Access a property to force validation.
 */
export const env: Env = new Proxy({} as Env, {
  get(_target, prop: string) {
    cached ??= parseEnv();
    return cached[prop as keyof Env];
  },
  has(_target, prop: string) {
    cached ??= parseEnv();
    return prop in cached;
  },
  ownKeys() {
    cached ??= parseEnv();
    return Reflect.ownKeys(cached);
  },
  getOwnPropertyDescriptor() {
    return { enumerable: true, configurable: true };
  },
});

/** Throws with a readable report if anything is missing. Used by /api/health. */
export function assertEnv(): Env {
  cached ??= parseEnv();
  return cached;
}

export const isProduction = () => env.NODE_ENV === "production";

/** IndiaMART polling is off unless a CRM key is configured. */
export const isIndiamartEnabled = () => env.INDIAMART_CRM_KEY.length > 0;

/** Meta Lead Ads is off unless an app secret is configured. */
export const isMetaEnabled = () => env.META_APP_SECRET.length > 0;

/** Cron routes refuse every request unless a secret is configured. */
export const isCronEnabled = () => env.CRON_SECRET.length > 0;

export const metaWebhookUrl = () => `${env.APP_URL}/api/webhooks/meta`;

/**
 * Subscription billing is off unless every Dodo Payments credential is
 * configured - the same "empty means off" convention as isIndiamartEnabled()
 * and isMetaEnabled(). While this is false, the Renew flow does not appear
 * anywhere in the app and the webhook route refuses every request; the
 * platform administrator's manual override at /admin keeps working exactly
 * as before.
 */
export const isBillingEnabled = () =>
  env.DODO_PAYMENTS_API_KEY.length > 0 &&
  env.DODO_PAYMENTS_WEBHOOK_SECRET.length > 0 &&
  env.DODO_PAYMENTS_PRODUCT_ID.length > 0;

/** https://test.dodopayments.com in test mode, https://live.dodopayments.com once switched over. */
export const dodoPaymentsApiBase = () =>
  env.DODO_PAYMENTS_MODE === "live"
    ? "https://live.dodopayments.com"
    : "https://test.dodopayments.com";

export const dodoPaymentsWebhookUrl = () =>
  `${env.APP_URL}/api/webhooks/dodo-payments`;
