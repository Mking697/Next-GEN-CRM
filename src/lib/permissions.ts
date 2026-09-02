import type { Role } from "@/generated/prisma/enums";

/**
 * THE permission table.
 *
 * This module is the only place that says who may do what. Two consumers read
 * it and they can never disagree:
 *
 *   1. The server actions and data functions, via can() / requirePermission().
 *   2. The per-user Guidebook page, via permissionsForRole().
 *
 * A guidebook entry is not prose written next to the code; it IS the same row
 * the check reads. Adding a permission without granting it to a role makes it
 * appear under "Not available to you" automatically.
 */

export const ROLES = ["OWNER", "ADMIN", "SALESMAN", "CRE"] as const;

export const ROLE_LABEL: Record<Role, string> = {
  OWNER: "Owner",
  ADMIN: "Admin",
  SALESMAN: "Salesman",
  CRE: "CRE",
};

export const ROLE_TAGLINE: Record<Role, string> = {
  OWNER:
    "The first account. Everything an admin can do, plus creating admins. Nobody can delete you.",
  ADMIN:
    "You run the team roster: create and delete salesmen and CREs, assign each CRE to a salesman, and watch every number.",
  SALESMAN:
    "You grab leads out of the shared pool, work them, and hand each one to one of your CREs to quote and close. You keep visibility on everything that follows.",
  CRE: "You take the leads your salesman hands you, build the quotation, place the order once it is accepted, collect the money and close it.",
};

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const PERMISSION_GROUPS = [
  { id: "pool", title: "The lead pool" },
  { id: "leads", title: "Working leads" },
  { id: "quotations", title: "Quotations" },
  { id: "orders", title: "Orders" },
  { id: "money", title: "Payments" },
  { id: "people", title: "People and accounts" },
  { id: "reporting", title: "Overview and reporting" },
  { id: "integrations", title: "Lead sources" },
  { id: "workspace", title: "Your company" },
] as const;

export type GroupId = (typeof PERMISSION_GROUPS)[number]["id"];

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface PermissionDef {
  group: GroupId;
  /** What the holder can do, phrased for the person reading the guidebook. */
  title: string;
  /** The real behaviour and its limits. Shown under the title. */
  detail: string;
  /** Overrides `detail` for a specific role where the scope differs. */
  detailByRole?: Partial<Record<Role, string>>;
  roles: readonly Role[];
}

const ALL_ROLES = ["OWNER", "ADMIN", "SALESMAN", "CRE"] as const;
const MANAGEMENT = ["OWNER", "ADMIN"] as const;
const NOT_CRE = ["OWNER", "ADMIN", "SALESMAN"] as const;

export const PERMISSIONS = {
  // -- pool ----------------------------------------------------------------
  "pool.view": {
    group: "pool",
    title: "See the lead pool",
    detail:
      "Every lead that nobody owns yet, newest first, whatever its source. A CRE never sees the pool.",
    detailByRole: {
      SALESMAN:
        "Every lead that nobody owns yet. You are competing with the other salesmen for these, so the list is live.",
    },
    roles: NOT_CRE,
  },
  "lead.grab": {
    group: "pool",
    title: "Grab a lead from the pool",
    detail:
      "Takes the lead out of the pool and puts it in your list. The grab is race safe: if two salesmen press it at the same instant exactly one wins, and the other is told the lead was already taken.",
    roles: ["SALESMAN"],
  },
  "lead.assign": {
    group: "pool",
    title: "Assign a pooled lead to a salesman",
    detail:
      "Hand a specific pooled lead to a specific salesman instead of waiting for somebody to grab it. Only works while the lead is still unowned.",
    roles: MANAGEMENT,
  },

  // -- leads ---------------------------------------------------------------
  "lead.create": {
    group: "leads",
    title: "Type in a new lead by hand",
    detail:
      "The manual source. A name is the only thing required; phone, email, company, city and product are all optional. If the phone or email already exists on another lead you are shown the existing one instead of creating a duplicate.",
    detailByRole: {
      SALESMAN:
        "The manual source, for a client you found yourself. Only a name is required. The lead is yours immediately, it does not go to the pool. If the phone or email matches an existing lead you are shown that one instead.",
    },
    roles: NOT_CRE,
  },
  "lead.view.own": {
    group: "leads",
    title: "See the leads that belong to you",
    detail: "Everything you own, at every status.",
    detailByRole: {
      CRE: "The leads your salesman has handed to you. You cannot edit the lead itself; the customer details you need go on the quotation.",
    },
    roles: ALL_ROLES,
  },
  "lead.handover.cre": {
    group: "leads",
    title: "Hand a lead to a CRE",
    detail:
      "Passes the lead to a CRE so they can quote it and place the order. You stay the owner, so it still counts as yours on the Overview and you keep watching it all the way to payment.",
    detailByRole: {
      SALESMAN:
        "You can only choose from the CREs assigned to you. You stay the owner of the lead, so it still counts as your grab on the Overview.",
    },
    roles: ["OWNER", "ADMIN", "SALESMAN"],
  },
  "lead.view.all": {
    group: "leads",
    title: "See every lead in the company",
    detail: "Grabbed or not, whoever owns it. Salesmen only ever see their own.",
    roles: MANAGEMENT,
  },
  "lead.update": {
    group: "leads",
    title: "Edit a lead and log follow-ups",
    detail:
      "Fill in the fields the source did not send, write notes and set the next follow-up date. Every change is added to the lead timeline with your name on it.",
    detailByRole: {
      SALESMAN:
        "On your own leads only. A lead you have not grabbed is read-only to you.",
    },
    roles: NOT_CRE,
  },
  "lead.status.set": {
    group: "leads",
    title: "Move a lead between NEW, FOLLOW_UP and LOST",
    detail:
      "ORDER_CONFIRMED is not set by hand: it is what confirming an order does. Marking a lead LOST asks you for a reason.",
    roles: NOT_CRE,
  },

  // -- quotations ----------------------------------------------------------
  "quotation.create": {
    group: "quotations",
    title: "Build a quotation",
    detail:
      "From a lead handed to you, or standalone for a walk-in customer. Every line is typed by hand on a spreadsheet-style grid; there are no preset panel pickers.",
    detailByRole: {
      SALESMAN:
        "From one of your own leads, or standalone for a walk-in. You do not have to involve a CRE at all: quote it, send it, place the order, collect and close it yourself. Or hand it to one of your CREs at any point, and they carry on from there.",
    },
    roles: ["OWNER", "ADMIN", "SALESMAN", "CRE"],
  },
  "quotation.handover": {
    group: "quotations",
    title: "Hand a quotation to a CRE",
    detail:
      "Works at any stage, including after the order has been placed. The CRE takes over the quotation, the order it became and the lead behind it in one step. Only CREs who work for the salesman the quotation is credited to can be picked.",
    roles: ["OWNER", "ADMIN", "SALESMAN"],
  },
  "quotation.update": {
    group: "quotations",
    title: "Edit and rework a quotation",
    detail:
      "Add, edit and remove rows, set freight and GST, and rewrite the subject, note and terms. Every save that actually changes something is kept as a numbered revision with a list of what moved, so the whole negotiation can be read back, and any earlier version can be opened in full. A quotation stays editable after an order has been placed from it: the order value follows the new payable amount, and the reference number never changes.",
    detailByRole: {
      SALESMAN:
        "Every quotation credited to you, including the ones your CREs built. Editing after an order exists is allowed and updates the order value with it. Your email is stamped on the revision, so the history always says who changed what.",
    },
    roles: ["OWNER", "ADMIN", "SALESMAN", "CRE"],
  },
  "quotation.view.own": {
    group: "quotations",
    title: "See your own quotations",
    detail: "With the customer, the totals and the PDF.",
    detailByRole: {
      SALESMAN:
        "The quotations your CREs have built on your leads. You can read them and download the PDF, but not change them.",
      CRE: "Everything you have quoted, at every status.",
    },
    roles: ALL_ROLES,
  },
  "quotation.view.all": {
    group: "quotations",
    title: "See every quotation in the company",
    detail: "Across all CREs.",
    roles: MANAGEMENT,
  },
  "quotation.pdf": {
    group: "quotations",
    title: "Download the quotation PDF",
    detail:
      "Generated fresh from the current data each time, so the file always matches what is on screen.",
    roles: ALL_ROLES,
  },
  "quotation.send": {
    group: "quotations",
    title: "Mark a quotation as sent",
    detail:
      "Moves it out of draft and stamps the date, so the document has a record of when it went out.",
    roles: ["OWNER", "ADMIN", "SALESMAN", "CRE"],
  },
  "quotation.delete": {
    group: "quotations",
    title: "Delete a quotation",
    detail:
      "Only possible while no order has been placed from it.",
    roles: MANAGEMENT,
  },

  // -- orders --------------------------------------------------------------
  "order.confirm": {
    group: "orders",
    title: "Place an order from an accepted quotation",
    detail:
      "Creates the company, the contact and the order in one step, and moves the lead to ORDER_CONFIRMED. The order value is the payable amount on the quotation, so the two can never disagree.",
    detailByRole: {
      CRE: "Once the customer accepts your quotation, place the order. Its value is the payable amount you quoted, and you keep it to collect against.",
      SALESMAN:
        "On your own quotations, whether a CRE built them or you did. An order you placed yourself stays with you to collect against until you hand it to a CRE.",
    },
    roles: ["OWNER", "ADMIN", "SALESMAN", "CRE"],
  },
  "order.delete": {
    group: "orders",
    title: "Delete an order",
    detail:
      "For an order raised by mistake. Deleting it also deletes every payment recorded against it, moves the lead back to follow-up and returns the quotation to sent, so it can be corrected and placed again. What was destroyed - the value, how much had been received and how many payments - is written to the audit trail first.",
    roles: MANAGEMENT,
  },
  "order.handover": {
    group: "orders",
    title: "Move an order to a CRE",
    detail:
      "Only CREs assigned to the salesman on that order can be picked.",
    detailByRole: {
      SALESMAN:
        "Hand an order you are holding to one of your CREs, or move it between them. Only your own CREs can be picked.",
    },
    roles: ["OWNER", "ADMIN", "SALESMAN"],
  },
  "order.view.own": {
    group: "orders",
    title: "See your own orders",
    detail: "Every order that is yours, with its amount, received and due.",
    detailByRole: {
      SALESMAN:
        "Every order you confirmed, including the ones you have already handed to a CRE. You keep visibility after handover.",
      CRE: "Every order that has been handed to you. You do not see the rest of the orders in the company.",
    },
    roles: ALL_ROLES,
  },
  "order.view.all": {
    group: "orders",
    title: "See every order in the company",
    detail: "Across all salesmen and all CREs.",
    roles: MANAGEMENT,
  },
  "order.update": {
    group: "orders",
    title: "Edit the value and notes on an order",
    detail:
      "The value can never be dropped below what has already been received against it.",
    detailByRole: {
      SALESMAN:
        "On the orders credited to you, including the ones your CREs are holding. The value can never be dropped below what has already been received.",
    },
    roles: ["OWNER", "ADMIN", "SALESMAN", "CRE"],
  },

  // -- money ---------------------------------------------------------------
  "payment.record": {
    group: "money",
    title: "Record a payment against an order",
    detail:
      "Part payments are fine and an order can have as many as it needs. A payment that would take the total past the order value is refused, so received can never exceed the amount.",
    detailByRole: {
      CRE: "On the orders handed to you. Part payments are fine and you can record as many as you need. Anything that would take the total past the order value is refused.",
      SALESMAN:
        "On any order credited to you, including ones you are holding yourself because you never handed them to a CRE.",
    },
    roles: ["OWNER", "ADMIN", "SALESMAN", "CRE"],
  },
  "payment.delete": {
    group: "money",
    title: "Delete a wrongly entered payment",
    detail:
      "Reverses a mistake. The paid state of the order recomputes immediately, and a closed order reopens if it is no longer fully paid.",
    roles: MANAGEMENT,
  },
  "order.close": {
    group: "money",
    title: "Close a fully paid order",
    detail:
      "Only possible when due is exactly zero. An order with anything outstanding cannot be closed.",
    detailByRole: {
      CRE: "Once you have collected everything and due reads zero, close the order. Until then it is refused.",
      SALESMAN:
        "On any order credited to you. Only possible when due reads exactly zero.",
    },
    roles: ["OWNER", "ADMIN", "SALESMAN", "CRE"],
  },

  // -- people --------------------------------------------------------------
  "user.view": {
    group: "people",
    title: "See the people list",
    detail: "Everybody, their role, and which salesman each CRE sits under.",
    roles: MANAGEMENT,
  },
  "user.create.staff": {
    group: "people",
    title: "Create salesman and CRE accounts",
    detail:
      "You set the email and the starting password by hand. Nobody can sign themselves up. Creating a CRE requires choosing the salesman they report to.",
    roles: MANAGEMENT,
  },
  "user.create.admin": {
    group: "people",
    title: "Create admin accounts",
    detail: "Only the owner can mint another admin.",
    roles: ["OWNER"],
  },
  "user.update": {
    group: "people",
    title: "Edit somebody's details",
    detail:
      "Name, email and phone. Changing an email changes what that person signs in with, so an admin cannot edit another admin - only the owner can.",
    roles: MANAGEMENT,
  },
  "user.assign.cre": {
    group: "people",
    title: "Choose which salesmen a CRE works for",
    detail:
      "A CRE can work for one salesman or several. When they have more than one, they pick which of them they are working as from the sidebar, and that decides which leads they see and who a new quotation is credited to. Changing the list does not touch the leads or orders they are already holding.",
    roles: MANAGEMENT,
  },
  "user.password.reset": {
    group: "people",
    title: "Reset a password for somebody",
    detail:
      "Sets a new password and signs that person out of every device immediately.",
    roles: MANAGEMENT,
  },
  "user.delete": {
    group: "people",
    title: "Delete a salesman or a CRE",
    detail:
      "Nothing is ever destroyed. Deleting a CRE moves their orders and leads to the salesman they were assigned to. Deleting a salesman makes you pick another salesman first, and their leads, orders and CREs all move there. Stage, status and payment history are untouched, and the whole move is one database transaction.",
    detailByRole: {
      OWNER:
        "Salesmen, CREs and admins. Nothing is ever destroyed. Deleting a CRE moves their orders and leads to the salesman they were assigned to. Deleting a salesman makes you pick another salesman first, and their leads, orders and CREs all move there. Stage, status and payment history are untouched, and the whole move is one database transaction. You are the one account nobody can delete.",
    },
    roles: MANAGEMENT,
  },

  // -- reporting -----------------------------------------------------------
  "overview.view.self": {
    group: "reporting",
    title: "See your own numbers on the Overview",
    detail: "For whichever month you pick at the top of the page.",
    detailByRole: {
      SALESMAN:
        "Your row only: grabbed, working, confirmed, lost, order value and received, for the month you pick.",
      CRE: "Your own orders only: what you are holding, what you closed, and what you collected in the month you pick.",
    },
    roles: ALL_ROLES,
  },
  "overview.view.team": {
    group: "reporting",
    title: "Drill into the CREs under you",
    detail:
      "Open your own row to see each of your CREs, the orders they hold, how many they closed and how much they collected.",
    roles: ["SALESMAN"],
  },
  "overview.view.all": {
    group: "reporting",
    title: "See the whole company on the Overview",
    detail:
      "Every salesman as a row, and every salesman opens up to the CREs underneath them.",
    roles: MANAGEMENT,
  },
  "audit.view": {
    group: "reporting",
    title: "Read the audit trail",
    detail:
      "Every account deletion and every bulk transfer of work, with who did it and where the leads and orders went.",
    roles: MANAGEMENT,
  },

  // -- the workspace itself --------------------------------------------------
  "workspace.view": {
    group: "workspace",
    title: "See your company details",
    detail:
      "The name, address, GSTIN, logo and bank account that print on every quotation your company sends.",
    roles: ALL_ROLES,
  },
  "workspace.edit": {
    group: "workspace",
    title: "Change your company details and logo",
    detail:
      "What a customer reads at the top of a quotation, and the account they pay into. Changing it changes every quotation printed afterwards, but not the ones already sent - those carry their own snapshot of the customer, and the letterhead is read fresh each time it is rendered.",
    roles: MANAGEMENT,
  },
  "workspace.billing": {
    group: "workspace",
    title: "Renew the subscription",
    detail:
      "Pay through Dodo Payments for another 30 days. A renewal made before the current subscription runs out stacks on top of it rather than resetting the clock. Only appears once a platform administrator has configured real Dodo Payments keys - until then, extending the subscription is done by them from the platform console, exactly as before.",
    roles: ["OWNER"],
  },

  // -- integrations --------------------------------------------------------
  "integration.view": {
    group: "integrations",
    title: "See lead source status",
    detail:
      "Whether IndiaMART and Meta are configured, when IndiaMART last ran, what it pulled, and the exact webhook URL to paste into Meta.",
    roles: MANAGEMENT,
  },
  "integration.sync.run": {
    group: "integrations",
    title: "Trigger an IndiaMART pull by hand",
    detail:
      "Runs the same job the scheduler runs. IndiaMART refuses more than one call every 5 minutes, so if the last call was recent this tells you how long is left instead of calling.",
    roles: MANAGEMENT,
  },
} as const satisfies Record<string, PermissionDef>;

export type PermissionId = keyof typeof PERMISSIONS;

export const PERMISSION_IDS = Object.keys(PERMISSIONS) as PermissionId[];

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

export function can(role: Role, permission: PermissionId): boolean {
  const def = PERMISSIONS[permission] as PermissionDef;
  return (def.roles as readonly Role[]).includes(role);
}

export class AuthorizationError extends Error {
  readonly permission: PermissionId;
  constructor(permission: PermissionId, role: Role) {
    const def = PERMISSIONS[permission] as PermissionDef;
    super(`A ${ROLE_LABEL[role]} cannot ${def.title.toLowerCase()}.`);
    this.name = "AuthorizationError";
    this.permission = permission;
  }
}

export function requirePermission(role: Role, permission: PermissionId): void {
  if (!can(role, permission)) throw new AuthorizationError(permission, role);
}

// ---------------------------------------------------------------------------
// Data visibility
// ---------------------------------------------------------------------------

/**
 * How wide the view of each collection is for each role. The data layer turns
 * these into Prisma `where` clauses and the guidebook prints them in words, so
 * a role can never be shown a scope the queries do not actually apply.
 */
export type Scope = "ALL" | "OWN" | "TEAM" | "ASSIGNED" | "NONE";

export interface RoleScopes {
  /** Unowned leads. */
  pool: Scope;
  /** Leads. ASSIGNED means "the ones handed to me", which is how a CRE sees them. */
  leads: Scope;
  /** Quotations. */
  quotations: Scope;
  /** Orders. TEAM means "orders on my leads, including ones my CREs hold". */
  orders: Scope;
  /** The client book. TEAM means "the book of the salesman heading my team". */
  clients: Scope;
  /** Overview aggregates. */
  overview: Scope;
  /** The people list. */
  users: Scope;
}

export const DATA_SCOPES: Record<Role, RoleScopes> = {
  OWNER: {
    pool: "ALL",
    leads: "ALL",
    quotations: "ALL",
    orders: "ALL",
    clients: "ALL",
    overview: "ALL",
    users: "ALL",
  },
  ADMIN: {
    pool: "ALL",
    leads: "ALL",
    quotations: "ALL",
    orders: "ALL",
    clients: "ALL",
    overview: "ALL",
    users: "ALL",
  },
  SALESMAN: {
    pool: "ALL",
    leads: "OWN",
    // Quotations their CREs built on their leads: readable, not editable.
    quotations: "TEAM",
    orders: "TEAM",
    // Their own book. This was NONE while quotation.create was closed to
    // salesmen, on the grounds that the client list is only ever reached
    // through quotation building. That stopped being true the moment a
    // salesman could raise one, and NONE would have left them staring at an
    // empty client picker.
    clients: "TEAM",
    overview: "TEAM",
    // A salesman has no people list: user.view is management-only.
    users: "NONE",
  },
  CRE: {
    pool: "NONE",
    // Not "OWN": a CRE owns no leads. They see the ones handed to them.
    leads: "ASSIGNED",
    quotations: "OWN",
    // Not "OWN" either: an order is handed to a CRE, exactly like a lead.
    // This is what lets ordersWhere() switch on scope alone.
    orders: "ASSIGNED",
    clients: "TEAM",
    overview: "OWN",
    users: "NONE",
  },
};

export const SCOPE_WORDS: Record<Scope, string> = {
  ALL: "everyone in the company",
  TEAM: "you and the CREs assigned to you",
  ASSIGNED: "the ones handed to you",
  OWN: "only what is yours",
  NONE: "nothing",
};

/** Collection names as the guidebook prints them. */
export const SCOPE_LABELS: Record<keyof RoleScopes, string> = {
  pool: "The lead pool",
  leads: "Leads",
  quotations: "Quotations",
  orders: "Orders",
  clients: "The client book",
  overview: "Overview figures",
  users: "People",
};

export const SCOPE_KEYS = Object.keys(SCOPE_LABELS) as (keyof RoleScopes)[];

/**
 * Where the generic scope word would overstate or misstate the clause.
 *
 * Same idea as `detailByRole` on a permission: one table, with the exceptions
 * declared next to the rule rather than hidden in the query.
 */
const SCOPE_WORD_OVERRIDES: Partial<
  Record<Role, Partial<Record<keyof RoleScopes, string>>>
> = {
  OWNER: {
    // leadsWhere() ALL is `ownerId: not null` - the pool has its own page.
    leads: "every lead that somebody owns; the pool is listed separately",
    // overviewSalesmanWhere() ALL is `role: SALESMAN`.
    overview: "every salesman in the company",
  },
  ADMIN: {
    leads: "every lead that somebody owns; the pool is listed separately",
    overview: "every salesman in the company",
  },
  SALESMAN: {
    // A client book belongs to a salesman; their CREs quote out of it but
    // own none of it, so the generic TEAM wording would overstate this.
    clients: "your own client book",
  },
  CRE: {
    clients: "the client book of the salesman you are working as",
  },
};

/** The words for one role and one collection, overrides applied. */
export function scopeWords(role: Role, key: keyof RoleScopes): string {
  return SCOPE_WORD_OVERRIDES[role]?.[key] ?? SCOPE_WORDS[DATA_SCOPES[role][key]];
}

// ---------------------------------------------------------------------------
// The invariant tying the two tables together
// ---------------------------------------------------------------------------

/**
 * The permission that has to be held before a collection can be read at all.
 *
 * DATA_SCOPES and PERMISSIONS are separate tables, and nothing in the type
 * system stops them contradicting each other: a role can be handed a scope on
 * a collection whose reading permission it does not hold, and then the
 * guidebook prints a visibility the app will never grant. This map is what
 * makes that contradiction detectable.
 */
const SCOPE_READERS: Record<keyof RoleScopes, PermissionId> = {
  pool: "pool.view",
  leads: "lead.view.own",
  quotations: "quotation.view.own",
  orders: "order.view.own",
  clients: "quotation.create",
  overview: "overview.view.self",
  users: "user.view",
};

/**
 * Every role/collection pair where a non-NONE scope is granted without the
 * permission that reads it. Empty means the two tables agree.
 *
 * Surfaced by /api/health so a mismatch is caught by the deploy check rather
 * than by a user reading a guidebook entry that is not true.
 */
export function assertScopesAreReachable(): string[] {
  const problems: string[] = [];
  for (const role of ROLES) {
    for (const key of SCOPE_KEYS) {
      const scope = DATA_SCOPES[role][key];
      if (scope === "NONE") continue;
      const permission = SCOPE_READERS[key];
      if (!can(role, permission)) {
        problems.push(
          `${role} has ${key}="${scope}" but does not hold "${permission}", so that scope is never applied.`,
        );
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Guidebook helpers
// ---------------------------------------------------------------------------

export interface ResolvedPermission {
  id: PermissionId;
  group: GroupId;
  title: string;
  detail: string;
  granted: boolean;
}

function resolve(id: PermissionId, role: Role): ResolvedPermission {
  const def = PERMISSIONS[id] as PermissionDef;
  return {
    id,
    group: def.group,
    title: def.title,
    detail: def.detailByRole?.[role] ?? def.detail,
    granted: can(role, id),
  };
}

export interface GuidebookSection {
  group: GroupId;
  title: string;
  items: ResolvedPermission[];
}

/** Everything this role CAN do, grouped, in declaration order. */
export function permissionsForRole(role: Role): GuidebookSection[] {
  return PERMISSION_GROUPS.map((group) => ({
    group: group.id,
    title: group.title,
    items: PERMISSION_IDS.map((id) => resolve(id, role)).filter(
      (p) => p.granted && p.group === group.id,
    ),
  })).filter((section) => section.items.length > 0);
}

/**
 * Everything this role CANNOT do. Derived by negation from the same table, so
 * it stays honest without anybody maintaining a second list.
 */
export function restrictionsForRole(role: Role): ResolvedPermission[] {
  return PERMISSION_IDS.map((id) => resolve(id, role)).filter((p) => !p.granted);
}

/** Which roles this role is allowed to create. */
export function creatableRoles(role: Role): Role[] {
  const out: Role[] = [];
  if (can(role, "user.create.admin")) out.push("ADMIN");
  if (can(role, "user.create.staff")) out.push("SALESMAN", "CRE");
  return out;
}
