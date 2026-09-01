import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { DATA_SCOPES, type RoleScopes, type Scope } from "@/lib/permissions";
import type { SessionUser } from "@/lib/session";

/**
 * Turns the visibility scopes declared in lib/permissions into the actual
 * Prisma `where` clauses the queries run with.
 *
 * Every list and every detail lookup in the app goes through one of these.
 * That is what makes "a salesman sees only their own" a property of the data
 * layer rather than something each page has to remember, and it is why the
 * Guidebook can print the scope in words and be telling the truth.
 *
 * Two rules keep that honest, and both are load-bearing:
 *
 *   1. Every function below switches on a Scope and nothing else. No branch
 *      here may read `user.role`: the moment a clause depends on the role
 *      rather than the scope, the guidebook is printing one rule while the
 *      query runs another.
 *
 *   2. The switches are exhaustive with no default branch, so adding a scope
 *      to lib/permissions makes TypeScript fail here until every collection
 *      has decided what the new scope means. An `if` chain does not give that
 *      guarantee, which is why there are none left.
 */

/** A clause that matches nothing. Used for the NONE scope. */
const MATCH_NOTHING = { id: "__no_such_row__" } as const;

function scopeOf(user: SessionUser, key: keyof RoleScopes): Scope {
  return DATA_SCOPES[user.role][key];
}

/**
 * The salesman whose book this user is working out of right now.
 *
 * For a salesman that is themselves. For a CRE it is whichever of their
 * salesmen the sidebar switcher currently has selected. Expressed through
 * `salesmen.length` rather than through the role, so this file still never
 * branches on what somebody is.
 *
 * Null only when a CRE has no salesman assigned at all, which every caller
 * below turns into MATCH_NOTHING.
 */
function actingSalesmanId(user: SessionUser): string | null {
  return user.salesmen.length > 0 ? user.activeSalesmanId : user.id;
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

/**
 * The pool: leads nobody owns.
 *
 * A switch rather than a `!== "NONE"` test on purpose. That test read as a
 * safe default but was the one fail-open branch in this file: any scope it
 * did not recognise fell straight through to the whole pool.
 */
function poolWhereUnscoped(user: SessionUser): Prisma.LeadWhereInput {
  switch (scopeOf(user, "pool")) {
    case "ALL":
      return { ownerId: null };
    case "TEAM":
    case "ASSIGNED":
    case "OWN":
    case "NONE":
      return MATCH_NOTHING;
  }
}

/**
 * The "my leads" list.
 *
 * ALL      -> every owned lead (owner, admin). Pooled leads are deliberately
 *             excluded: they have their own page, and the guidebook now says
 *             so instead of claiming "everyone in the company".
 * OWN      -> leads this salesman grabbed
 * ASSIGNED -> leads handed to this CRE to quote
 */
function leadsWhereUnscoped(user: SessionUser): Prisma.LeadWhereInput {
  switch (scopeOf(user, "leads")) {
    case "ALL":
      return { ownerId: { not: null } };
    case "TEAM":
    case "OWN":
      return { ownerId: user.id };
    case "ASSIGNED": {
      // A CRE serving several salesmen sees one salesman at a time, following
      // the sidebar switcher. Only the LIST narrows: leadReadableWhere stays
      // wide, so switching salesman never breaks a link to a lead that is
      // genuinely theirs.
      const salesmanId =
        user.salesmen.length > 0 ? user.activeSalesmanId : null;
      return salesmanId
        ? { creId: user.id, ownerId: salesmanId }
        : { creId: user.id };
    }
    case "NONE":
      return MATCH_NOTHING;
  }
}

/**
 * The non-pool half of readability: a clause, "EVERYTHING", or null for a
 * scope that contributes nothing. Split out so leadReadableWhere can stay an
 * exhaustive switch rather than the if-chain it used to be.
 */
function ownedLeadsWhere(
  user: SessionUser,
): Prisma.LeadWhereInput | "EVERYTHING" | null {
  switch (scopeOf(user, "leads")) {
    case "ALL":
      return "EVERYTHING";
    case "TEAM":
    case "OWN":
      return { ownerId: user.id };
    case "ASSIGNED":
      return { creId: user.id };
    case "NONE":
      return null;
  }
}

/**
 * Everything this user may open the detail page for: their own leads, the
 * ones handed to them, plus the pool if they are allowed to see it.
 *
 * Unlike leadsWhere, ALL here really is everything, pool included: a lead
 * visible on the pool page has to open.
 */
function leadReadableWhereUnscoped(user: SessionUser): Prisma.LeadWhereInput {
  const owned = ownedLeadsWhere(user);
  if (owned === "EVERYTHING") return {};

  const clauses: Prisma.LeadWhereInput[] = [];
  if (owned !== null) clauses.push(owned);
  if (scopeOf(user, "pool") !== "NONE") clauses.push(poolWhere(user));

  if (clauses.length === 0) return MATCH_NOTHING;
  return { OR: clauses };
}

/**
 * Leads this user may edit. The pool is readable but not editable, and a CRE
 * never edits the lead itself: the customer details they need live on the
 * quotation, which is theirs.
 */
function leadWritableWhereUnscoped(user: SessionUser): Prisma.LeadWhereInput {
  switch (scopeOf(user, "leads")) {
    case "ALL":
      return {};
    case "TEAM":
    case "OWN":
      return { ownerId: user.id };
    case "ASSIGNED":
    case "NONE":
      return MATCH_NOTHING;
  }
}

// ---------------------------------------------------------------------------
// Quotations
// ---------------------------------------------------------------------------

/**
 * ALL  -> every quotation (owner, admin)
 * TEAM -> a salesman sees quotations raised on their leads, and anything
 *         their own CREs quoted standalone
 * OWN  -> a CRE sees what they built
 */
function quotationsWhereUnscoped(user: SessionUser): Prisma.QuotationWhereInput {
  switch (scopeOf(user, "quotations")) {
    case "ALL":
      return {};
    case "TEAM":
      // salesmanId is the real answer now that a quotation carries one. The
      // lead clause stays as a safety net for rows the migration could not
      // resolve a salesman for (no lead, and a CRE with no salesman at the
      // time), which would otherwise be visible to nobody but an admin.
      return {
        OR: [{ salesmanId: user.id }, { lead: { ownerId: user.id } }],
      };
    case "ASSIGNED":
    case "OWN":
      return { creId: user.id };
    case "NONE":
      return MATCH_NOTHING;
  }
}

/**
 * Quotations this user may change.
 *
 * TEAM used to match nothing: a salesman could read what their CREs built but
 * not touch it. It now matches the same set quotationsWhere does, because a
 * salesman owns the customer relationship and has to be able to correct a
 * quotation raised in their own name.
 */
function quotationWritableWhereUnscoped(
  user: SessionUser,
): Prisma.QuotationWhereInput {
  switch (scopeOf(user, "quotations")) {
    case "ALL":
      return {};
    case "ASSIGNED":
    case "OWN":
      return { creId: user.id };
    case "TEAM":
      return {
        OR: [{ salesmanId: user.id }, { lead: { ownerId: user.id } }],
      };
    case "NONE":
      return MATCH_NOTHING;
  }
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * ALL      -> every order (owner, admin)
 * TEAM     -> orders credited to this salesman, plus orders their CREs are
 *             holding right now
 * ASSIGNED -> orders handed to this CRE to collect against
 *
 * The TEAM clause unions two different facts on purpose. `salesmanId` is a
 * snapshot written when the order was placed; the CreSalesman join is live.
 * Changing which salesmen a CRE works for deliberately leaves orders alone, so
 * without the second half of this union the receiving salesman could not see
 * an order their own CRE was holding, even though quotationsWhere had already
 * moved them the quotation it came from. Both collections now answer the
 * question the same way.
 */
function ordersWhereUnscoped(user: SessionUser): Prisma.OrderWhereInput {
  switch (scopeOf(user, "orders")) {
    case "ALL":
      return {};
    case "TEAM":
      return {
        OR: [
          { salesmanId: user.id },
          { cre: { salesmen: { some: { salesmanId: user.id } } } },
        ],
      };
    case "ASSIGNED":
      return { creId: user.id };
    case "OWN":
      return { salesmanId: user.id };
    case "NONE":
      return MATCH_NOTHING;
  }
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

/**
 * Which client companies this user may quote for.
 *
 * A client book belongs to a salesman. TEAM therefore means "the book of the
 * salesman I am working as", which is themselves for a salesman and the
 * currently selected one for a CRE - see actingSalesmanId(), which says that
 * without this file having to know what a role is.
 */
function companiesWhereUnscoped(user: SessionUser): Prisma.CompanyWhereInput {
  switch (scopeOf(user, "clients")) {
    case "ALL":
      return {};
    case "TEAM": {
      // Not every book this CRE could reach - the one they are acting out of.
      // Switching salesman in the sidebar switches the client list with it.
      const salesmanId = actingSalesmanId(user);
      return salesmanId ? { salesmanId } : MATCH_NOTHING;
    }
    case "OWN":
      return { salesmanId: user.id };
    case "ASSIGNED":
    case "NONE":
      return MATCH_NOTHING;
  }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/** Who appears in this people list. */
function usersWhereUnscoped(user: SessionUser): Prisma.UserWhereInput {
  switch (scopeOf(user, "users")) {
    case "ALL":
      return {};
    case "TEAM":
      return {
        OR: [{ id: user.id }, { salesmen: { some: { salesmanId: user.id } } }],
      };
    case "ASSIGNED":
    case "OWN":
      return { id: user.id };
    case "NONE":
      return MATCH_NOTHING;
  }
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

/** Which salesmen this user is allowed to see rows for on the Overview. */
function overviewSalesmanWhereUnscoped(user: SessionUser): Prisma.UserWhereInput {
  switch (scopeOf(user, "overview")) {
    case "ALL":
      return { role: "SALESMAN" };
    case "TEAM":
      return { id: user.id };
    case "ASSIGNED":
    case "OWN":
      // A CRE has no salesman row of their own.
      return MATCH_NOTHING;
    case "NONE":
      return MATCH_NOTHING;
  }
}

// ---------------------------------------------------------------------------
// The tenant boundary
// ---------------------------------------------------------------------------

/**
 * Every clause above describes what one PERSON may see. This is what narrows
 * it to what their ORGANISATION may see, and the two are deliberately
 * separate concerns.
 *
 * It is applied here, at the boundary, rather than inside each switch. A
 * builder written next year cannot forget the organisation, because forgetting
 * it is not something an individual builder is able to do - the only way out
 * of this file is through one of the wrappers below.
 *
 * `{ orgId, ...clause }` and not the other way round: spreading the clause
 * second would let a clause carrying its own orgId overwrite the session's,
 * which is precisely the mistake this exists to make impossible.
 */
function inOrg<T extends object>(
  user: SessionUser,
  clause: T,
): T & { orgId: string } {
  return { ...clause, orgId: user.orgId };
}


export function poolWhere(user: SessionUser): Prisma.LeadWhereInput {
  return inOrg(user, poolWhereUnscoped(user));
}

export function leadsWhere(user: SessionUser): Prisma.LeadWhereInput {
  return inOrg(user, leadsWhereUnscoped(user));
}

export function leadReadableWhere(user: SessionUser): Prisma.LeadWhereInput {
  return inOrg(user, leadReadableWhereUnscoped(user));
}

export function leadWritableWhere(user: SessionUser): Prisma.LeadWhereInput {
  return inOrg(user, leadWritableWhereUnscoped(user));
}

export function quotationsWhere(user: SessionUser): Prisma.QuotationWhereInput {
  return inOrg(user, quotationsWhereUnscoped(user));
}

export function quotationWritableWhere(user: SessionUser): Prisma.QuotationWhereInput {
  return inOrg(user, quotationWritableWhereUnscoped(user));
}

export function ordersWhere(user: SessionUser): Prisma.OrderWhereInput {
  return inOrg(user, ordersWhereUnscoped(user));
}

export function companiesWhere(user: SessionUser): Prisma.CompanyWhereInput {
  return inOrg(user, companiesWhereUnscoped(user));
}

export function usersWhere(user: SessionUser): Prisma.UserWhereInput {
  return inOrg(user, usersWhereUnscoped(user));
}

export function overviewSalesmanWhere(user: SessionUser): Prisma.UserWhereInput {
  return inOrg(user, overviewSalesmanWhereUnscoped(user));
}
