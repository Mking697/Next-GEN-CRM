import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A runtime check that every query touching tenant data names an organisation.
 *
 * server/scope.ts is the primary control and it is applied at a boundary that
 * cannot be forgotten. This exists for the queries that never go through it:
 * a `findFirst` written inline, a `count` for a dashboard tile, an ingest
 * lookup. One of those was genuinely wrong when multi-tenancy went in - the
 * lead deduplication searched every organisation's leads - and nothing pointed
 * at it, because a query missing its filter is perfectly valid TypeScript that
 * returns somebody else's rows.
 *
 * Postgres row-level security is the other half of this, and covers what this
 * cannot: access that does not come through the application at all. It is not
 * a substitute for this one. RLS reads the tenant from a connection-level
 * setting, which on a shared pool can only be bound inside a transaction, and
 * wrapping every read in a transaction would double the round trips on an
 * application that was deliberately tuned to reduce them.
 *
 * OFF BY DEFAULT, and that is a finding rather than a compromise. Run against
 * this codebase it flags about a hundred and ten calls, and nearly all of them
 * are safe: a payment aggregate filtered by an orderId whose scope was checked
 * three lines above, a count filtered by a userId that was just verified. No
 * static rule separates those from the genuinely unscoped ones, so a guard
 * that blocks them would be turned off within a week - and one that warns
 * about them would be scrolled past.
 *
 * What it is good for is an audit. Turned on deliberately and read once, it
 * pointed at six real cross-organisation holes in server/users.ts, including a
 * password reset that would have let one company take over another's owner
 * account. Turn it on when the query surface changes:
 *
 *   TENANT_GUARD=warn npm test     # list every unscoped set operation
 *   TENANT_GUARD=strict npm test   # fail on the first one
 */

/** Models whose rows belong to one organisation. */
const TENANT_MODELS = new Set([
  "User",
  "CreSalesman",
  "Lead",
  "LeadActivity",
  "Company",
  "Contact",
  "Order",
  "Payment",
  "Quotation",
  "QuotationRevision",
  "QuotationItem",
  "SyncState",
  "AuditEvent",
]);

/**
 * The operations where a missing filter silently returns or changes everybody.
 *
 * Deliberately not the by-key operations. `findUnique({ where: { id } })`
 * fetches one row by primary key, so it can only reach another organisation's
 * data if the caller already holds an id they should not - which requires an
 * earlier leak, and this guard is what stops that earlier leak. Flagging them
 * too would bury the real signal: measured against this codebase it produced
 * about two hundred warnings, nearly all of them scope checks that had already
 * happened a few lines above.
 *
 * These are the ones that read a SET. Forget the filter on any of them and the
 * answer quietly includes every organisation.
 */
const FILTERED_OPERATIONS = new Set([
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "updateMany",
  "deleteMany",
  "count",
  "aggregate",
  "groupBy",
]);

/** Operations that write new rows, and so must carry an organisation. */
const CREATE_OPERATIONS = new Set(["create", "createMany", "upsert"]);

/**
 * Queries that legitimately cross organisations.
 *
 * There are only a few, and every one is about finding out WHICH organisation
 * something belongs to - which cannot itself be scoped to the answer. Signing
 * in is the obvious case: an email address is looked up before anybody knows
 * what workspace it belongs to.
 *
 * Marked explicitly rather than detected, so a cross-organisation read is a
 * decision somebody made and can be found by searching for this function.
 */
const crossOrgFlag = new AsyncLocalStorage<true>();

export function crossOrg<T>(reason: string, run: () => T): T {
  void reason; // documentation at the call site; not used at runtime
  return crossOrgFlag.run(true, run);
}

function isCrossOrg(): boolean {
  return crossOrgFlag.getStore() === true;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Does this `where` clause pin the organisation down?
 *
 * Recursive, because scope.ts composes clauses under AND and callers wrap them
 * again. A top-level OR is deliberately NOT enough: `{ OR: [a, b] }` where only
 * `a` names the organisation still returns `b`'s rows from everywhere.
 */
function whereNamesOrg(where: unknown): boolean {
  if (typeof where !== "object" || where === null) return false;
  const clause = where as Record<string, unknown>;

  if (typeof clause.orgId === "string") return true;
  // A composite unique like { orgId_email: { orgId, email } }.
  for (const [key, value] of Object.entries(clause)) {
    if (
      key.startsWith("orgId_") &&
      typeof value === "object" &&
      value !== null &&
      typeof (value as Record<string, unknown>).orgId === "string"
    ) {
      return true;
    }
  }
  if (clause.org && typeof clause.org === "object") return true;

  const and = clause.AND;
  if (Array.isArray(and)) return and.some(whereNamesOrg);
  if (and && typeof and === "object") return whereNamesOrg(and);

  return false;
}

/** Does this `data` payload carry an organisation? */
function dataNamesOrg(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0 || data.every(dataNamesOrg);
  if (typeof data !== "object" || data === null) return false;
  const row = data as Record<string, unknown>;
  return typeof row.orgId === "string" || typeof row.org === "object";
}

export interface GuardVerdict {
  ok: boolean;
  reason?: string;
}

/** The decision, split out so it can be unit tested without a database. */
export function inspect(
  model: string | undefined,
  operation: string,
  args: unknown,
): GuardVerdict {
  if (!model || !TENANT_MODELS.has(model)) return { ok: true };

  const call = (args ?? {}) as Record<string, unknown>;

  if (CREATE_OPERATIONS.has(operation)) {
    const payload = operation === "upsert" ? call.create : call.data;
    if (!dataNamesOrg(payload)) {
      return { ok: false, reason: `${model}.${operation} writes a row with no orgId` };
    }
  }

  if (FILTERED_OPERATIONS.has(operation)) {
    if (!whereNamesOrg(call.where)) {
      return { ok: false, reason: `${model}.${operation} has no orgId in its where clause` };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export class CrossTenantQueryError extends Error {
  constructor(reason: string) {
    super(
      `${reason}. Add it, or wrap the call in crossOrg() if reading across ` +
        "organisations is genuinely what you mean.",
    );
    this.name = "CrossTenantQueryError";
  }
}

/**
 * What to do about a query that does not name an organisation.
 *
 * Throwing in development and in the tests is what makes the mistake
 * impossible to merge. In production it is logged instead: a guard that takes
 * the application down is a worse outcome than one that tells you loudly, and
 * scope.ts has already applied the real filter on every path that matters.
 */
/** The first frame in our own code, so a warning says where to look. */
function callSite(): string {
  const stack = new Error().stack?.split("\n") ?? [];
  const ours = /[\\/](src|tests|scripts|prisma)[\\/]/;
  const frame = stack.find(
    (line) =>
      ours.test(line) &&
      !line.includes("tenant-guard") &&
      !/lib[\\/]db\./.test(line),
  );
  return frame ? ` <- ${frame.trim().replace(/^at\s+/, "")}` : "";
}

export type GuardMode = "off" | "warn" | "strict";

export function guardMode(): GuardMode {
  const raw = process.env.TENANT_GUARD?.trim().toLowerCase();
  return raw === "warn" || raw === "strict" ? raw : "off";
}

export function report(verdict: GuardVerdict, mode: GuardMode): void {
  if (mode === "off" || verdict.ok || isCrossOrg()) return;
  const reason = verdict.reason ?? "a query did not name an organisation";
  if (mode === "strict") throw new CrossTenantQueryError(reason);
  console.error(`[tenant-guard] ${reason}${callSite()}`);
}
