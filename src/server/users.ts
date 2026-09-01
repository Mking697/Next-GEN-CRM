import "server-only";
import { prisma } from "@/lib/db";
import type { Role } from "@/generated/prisma/enums";
import { ConflictError, NotFoundError, ValidationError } from "@/lib/errors";
import { can, requirePermission, ROLE_LABEL } from "@/lib/permissions";
import type { SessionUser } from "@/lib/session";
import { destroyAllSessions } from "@/lib/session";
import { hashPassword, validatePassword } from "@/lib/password";
import { cleanText, normalizeEmail } from "@/lib/dedupe";
import { usersWhere } from "./scope";
import { audit } from "./audit";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface PersonRow {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: Role;
  isActive: boolean;
  /** For a CRE, every salesman they work for. Empty for other roles. */
  salesmen: { id: string; name: string }[];
  /** Only loaded by getPerson(); the list view has no use for it. */
  createdAt: Date;
  lastLoginAt: Date | null;
  counts: { leads: number; orders: number; creOrders: number; cres: number };
}

const SALESMEN_LINKS = {
  orderBy: { salesman: { name: "asc" } },
  select: { salesman: { select: { id: true, name: true } } },
} as const;

export async function listUsers(user: SessionUser): Promise<PersonRow[]> {
  requirePermission(user.role, "user.view");

  const rows = await prisma.user.findMany({
    where: usersWhere(user),
    orderBy: [{ role: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      isActive: true,
      createdAt: true,
      lastLoginAt: true,
      salesmen: SALESMEN_LINKS,
      _count: {
        select: {
          ownedLeads: true,
          salesOrders: true,
          creOrders: true,
          cres: true,
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    isActive: row.isActive,
    salesmen: row.salesmen.map((link) => link.salesman),
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    counts: {
      leads: row._count.ownedLeads,
      orders: row._count.salesOrders,
      creOrders: row._count.creOrders,
      cres: row._count.cres,
    },
  }));
}

/** One person, if this user is allowed to see them at all. */
export async function getPerson(
  actor: SessionUser,
  targetId: string,
): Promise<PersonRow | null> {
  requirePermission(actor.role, "user.view");

  const row = await prisma.user.findFirst({
    where: { AND: [{ id: targetId }, usersWhere(actor)] },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      isActive: true,
      createdAt: true,
      lastLoginAt: true,
      salesmen: SALESMEN_LINKS,
      _count: {
        select: {
          ownedLeads: true,
          salesOrders: true,
          creOrders: true,
          cres: true,
        },
      },
    },
  });
  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    isActive: row.isActive,
    salesmen: row.salesmen.map((link) => link.salesman),
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
    counts: {
      leads: row._count.ownedLeads,
      orders: row._count.salesOrders,
      creOrders: row._count.creOrders,
      cres: row._count.cres,
    },
  };
}

export async function listSalesmen(
  orgId: string,
): Promise<{ id: string; name: string; email: string; creCount: number }[]> {
  const rows = await prisma.user.findMany({
    where: { orgId, role: "SALESMAN", isActive: true },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      _count: { select: { cres: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    creCount: row._count.cres,
  }));
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  role: Role;
  phone?: string | null;
  /** Required when the role is CRE: the salesmen they work for, at least one. */
  salesmanIds?: string[];
}

/**
 * Resolve the salesmen a CRE is being linked to, refusing anything that is
 * not an active salesman. Shared by createUser and setCreSalesmen so the two
 * cannot drift on what counts as a valid assignment.
 */
async function validateSalesmanIds(
  orgId: string,
  ids: string[] | undefined,
): Promise<string[]> {
  const wanted = [...new Set((ids ?? []).filter((id) => id.length > 0))];
  if (wanted.length === 0) {
    throw new ValidationError("Choose at least one salesman for this CRE.", {
      salesmanIds: "Pick at least one salesman",
    });
  }

  const found = await prisma.user.findMany({
    where: { id: { in: wanted }, orgId, role: "SALESMAN", isActive: true },
    select: { id: true },
  });
  if (found.length !== wanted.length) {
    throw new ValidationError(
      "One of those is not an active salesman. Refresh the page and try again.",
      { salesmanIds: "Pick active salesmen only" },
    );
  }
  return found.map((salesman) => salesman.id);
}

/**
 * The admin creates every account. There is no self sign-up anywhere in this
 * application, which is why this is the only path that writes a User row
 * besides the seed script.
 */
export async function createUser(
  actor: SessionUser,
  input: CreateUserInput,
): Promise<{ id: string }> {
  assertCanCreateRole(actor, input.role);

  const name = cleanText(input.name, 120);
  if (!name) {
    throw new ValidationError("A name is required.", { name: "Enter a name" });
  }

  const email = normalizeEmail(input.email);
  if (!email) {
    throw new ValidationError("That email address does not look right.", {
      email: "Enter a valid email address",
    });
  }

  const passwordProblem = validatePassword(input.password);
  if (passwordProblem) {
    throw new ValidationError(passwordProblem, { password: passwordProblem });
  }

  // Unique within the organisation, so the lookup has to name it too.
  const existing = await prisma.user.findUnique({
    where: { orgId_email: { orgId: actor.orgId, email } },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError("Somebody already has that email address.");
  }

  // A CRE works for at least one salesman; everyone else for nobody.
  const salesmanIds =
    input.role === "CRE"
      ? await validateSalesmanIds(actor.orgId, input.salesmanIds)
      : [];

  const created = await prisma.user.create({
    data: {
      orgId: actor.orgId,
      name,
      email,
      phone: cleanText(input.phone, 40),
      role: input.role,
      passwordHash: await hashPassword(input.password),
      createdById: actor.id,
      salesmen: {
        create: salesmanIds.map((salesmanId) => ({
          orgId: actor.orgId,
          salesmanId,
        })),
      },
    },
    select: { id: true },
  });

  await audit(prisma, {
    orgId: actor.orgId,
    action: "user.create",
    actorId: actor.id,
    targetType: "User",
    targetId: created.id,
    detail: `${actor.name} created ${ROLE_LABEL[input.role]} ${name} (${email})`,
  });

  return created;
}

function assertCanCreateRole(actor: SessionUser, role: Role): void {
  if (role === "OWNER") {
    throw new ValidationError(
      "There is exactly one owner, created by the seed script. Another one cannot be added.",
    );
  }
  if (role === "ADMIN") {
    requirePermission(actor.role, "user.create.admin");
    return;
  }
  requirePermission(actor.role, "user.create.staff");
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/**
 * Set exactly which salesmen a CRE works for.
 *
 * Replaces the whole set rather than moving one link, because a CRE can now
 * serve several. Leads and orders they are already holding are untouched: an
 * order keeps its own salesman, and a lead keeps its owner, so unlinking a
 * salesman changes what the CRE can pick up next without rewriting what they
 * have already done.
 */
export async function setCreSalesmen(
  actor: SessionUser,
  creId: string,
  salesmanIds: string[],
): Promise<void> {
  requirePermission(actor.role, "user.assign.cre");

  const cre = await prisma.user.findFirst({
    where: { id: creId, role: "CRE", orgId: actor.orgId },
    select: {
      id: true,
      name: true,
      salesmen: { select: { salesmanId: true } },
    },
  });
  if (!cre) throw new NotFoundError("That CRE");

  const wanted = await validateSalesmanIds(actor.orgId, salesmanIds);
  const current = cre.salesmen.map((link) => link.salesmanId);

  const added = wanted.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !wanted.includes(id));
  if (added.length === 0 && removed.length === 0) return;

  const names = await prisma.user.findMany({
    where: { id: { in: wanted }, orgId: actor.orgId },
    orderBy: { name: "asc" },
    select: { name: true },
  });

  await prisma.$transaction(async (tx) => {
    if (removed.length > 0) {
      await tx.creSalesman.deleteMany({
        where: { creId: cre.id, salesmanId: { in: removed } },
      });
    }
    if (added.length > 0) {
      await tx.creSalesman.createMany({
        data: added.map((salesmanId) => ({
          orgId: actor.orgId,
          creId: cre.id,
          salesmanId,
        })),
      });
    }
    await audit(tx, {
      orgId: actor.orgId,
      action: "user.assign",
      actorId: actor.id,
      targetType: "User",
      targetId: cre.id,
      detail: `${actor.name} set CRE ${cre.name} to work for ${names
        .map((salesman) => salesman.name)
        .join(", ")}`,
    });
  });
}

export interface UpdateUserInput {
  name?: string;
  email?: string;
  phone?: string | null;
}

/**
 * Edit somebody's details.
 *
 * Answers to the same hierarchy as delete and deactivate: an admin cannot
 * rewrite another admin, because being able to change an email is being able
 * to take the account over.
 */
export async function updateUser(
  actor: SessionUser,
  targetId: string,
  input: UpdateUserInput,
): Promise<void> {
  requirePermission(actor.role, "user.update");

  // Scoped to the actor's organisation: targetId arrives from a form, and
  // without this an admin could name an account in another workspace.
  const target = await prisma.user.findFirst({
    where: { id: targetId, orgId: actor.orgId },
    select: { id: true, name: true, role: true, email: true },
  });
  if (!target) throw new NotFoundError("That account");

  // Editing yourself is always allowed; the hierarchy only guards other people.
  if (target.id !== actor.id) {
    const blocked = accountActionBlockReason(actor, target, "edit");
    if (blocked) throw new ConflictError(blocked);
  }

  const data: {
    name?: string;
    email?: string;
    phone?: string | null;
    } = {};

  if (input.name !== undefined) {
    const name = cleanText(input.name, 120);
    if (!name) {
      throw new ValidationError("A name is required.", { name: "Enter a name" });
    }
    data.name = name;
  }

  if (input.email !== undefined) {
    const email = normalizeEmail(input.email);
    if (!email) {
      throw new ValidationError("That email address does not look right.", {
        email: "Enter a valid email address",
      });
    }
    if (email !== target.email) {
      const clash = await prisma.user.findUnique({
        where: { orgId_email: { orgId: actor.orgId, email } },
        select: { id: true },
      });
      if (clash) throw new ConflictError("Somebody already has that email address.");
    }
    data.email = email;
  }

  if (input.phone !== undefined) data.phone = cleanText(input.phone, 40);

  if (Object.keys(data).length === 0) return;

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: target.id }, data });
    await audit(tx, {
      orgId: actor.orgId,
      action: "user.update",
      actorId: actor.id,
      targetType: "User",
      targetId: target.id,
      detail: `${actor.name} edited ${target.name} (${Object.keys(data).join(", ")})`,
    });
  });
}

export async function resetPassword(
  actor: SessionUser,
  targetId: string,
  newPassword: string,
): Promise<void> {
  requirePermission(actor.role, "user.password.reset");

  // Scoped to the actor's organisation: targetId arrives from a form, and
  // without this an admin could name an account in another workspace.
  const target = await prisma.user.findFirst({
    where: { id: targetId, orgId: actor.orgId },
    select: { id: true, name: true, role: true },
  });
  if (!target) throw new NotFoundError("That account");

  // Only the owner may reset an owner or an admin password.
  if (
    (target.role === "OWNER" || target.role === "ADMIN") &&
    actor.role !== "OWNER" &&
    actor.id !== target.id
  ) {
    throw new ConflictError(
      "Only the owner can reset an admin or owner password.",
    );
  }

  const problem = validatePassword(newPassword);
  if (problem) throw new ValidationError(problem, { password: problem });

  await prisma.user.update({
    where: { id: target.id },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  // Signed out everywhere, immediately.
  await destroyAllSessions(target.id);

  await audit(prisma, {
    orgId: actor.orgId,
    action: "user.password.reset",
    actorId: actor.id,
    targetType: "User",
    targetId: target.id,
    detail: `${actor.name} reset the password for ${target.name} and signed them out of every device`,
  });
}

/** Deactivate without deleting. Keeps every row, blocks sign-in. */
export async function setUserActive(
  actor: SessionUser,
  targetId: string,
  isActive: boolean,
): Promise<void> {
  requirePermission(actor.role, "user.delete");

  // Scoped to the actor's organisation: targetId arrives from a form, and
  // without this an admin could name an account in another workspace.
  const target = await prisma.user.findFirst({
    where: { id: targetId, orgId: actor.orgId },
    select: { id: true, name: true, role: true },
  });
  if (!target) throw new NotFoundError("That account");

  // Deactivating deletes every session and blocks sign-in, which is the same
  // loss of access a delete causes. It therefore answers to the same rules -
  // including "only the owner may act on an admin", which this used to skip
  // while deleteUser() enforced it.
  const blocked = accountActionBlockReason(actor, target, isActive ? "reactivate" : "deactivate");
  if (blocked) throw new ConflictError(blocked);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: target.id }, data: { isActive } });
    if (!isActive) await tx.session.deleteMany({ where: { userId: target.id } });
    await audit(tx, {
      orgId: actor.orgId,
      action: isActive ? "user.activate" : "user.deactivate",
      actorId: actor.id,
      targetType: "User",
      targetId: target.id,
      detail: `${actor.name} ${isActive ? "reactivated" : "deactivated"} ${target.name}`,
    });
  });
}

// ---------------------------------------------------------------------------
// Deleting - the rule that matters most
// ---------------------------------------------------------------------------

export interface DeletionPreview {
  id: string;
  name: string;
  role: Role;
  /** Where the work goes. Fixed for a CRE, chosen by the admin for a salesman. */
  destination: { id: string; name: string } | null;
  /** True when the caller must pick a destination themselves. */
  needsChoice: boolean;
  moving: { leads: number; orders: number; creOrders: number; cres: number };
  /** Candidates for the destination dropdown. */
  candidates: { id: string; name: string; email: string }[];
  /** Non-empty means the delete cannot go ahead at all. */
  blockedReason: string | null;
}

/**
 * What a delete would do, worked out before anything is destroyed, so the
 * confirmation screen states the real consequence rather than a guess.
 */
export async function previewDeletion(
  actor: SessionUser,
  targetId: string,
): Promise<DeletionPreview> {
  requirePermission(actor.role, "user.delete");

  // Scoped to the actor's organisation: targetId arrives from a form, and
  // without this an admin could name an account in another workspace.
  const target = await prisma.user.findFirst({
    where: { id: targetId, orgId: actor.orgId },
    select: {
      id: true,
      name: true,
      role: true,
      _count: {
        select: {
          ownedLeads: true,
          salesOrders: true,
          creOrders: true,
          cres: true,
        },
      },
    },
  });
  if (!target) throw new NotFoundError("That account");

  const moving = {
    leads: target._count.ownedLeads,
    orders: target._count.salesOrders,
    creOrders: target._count.creOrders,
    cres: target._count.cres,
  };

  const blockedReason = deletionBlockReason(actor, target);

  const candidates = await prisma.user.findMany({
    where: {
      orgId: actor.orgId,
      role: "SALESMAN",
      isActive: true,
      NOT: { id: target.id },
    },
    orderBy: { name: "asc" },
    select: { id: true, name: true, email: true },
  });

  // A CRE needs no destination at all. Their orders keep the salesman they
  // were already credited to and simply lose their CRE, and a CRE owns no
  // leads and heads no team. There used to be a single manager to send the
  // work to; now there can be several, and none of them is the right answer.
  if (target.role === "CRE") {
    return {
      id: target.id,
      name: target.name,
      role: target.role,
      destination: null,
      needsChoice: false,
      moving,
      candidates,
      blockedReason,
    };
  }

  const hasWork =
    moving.leads > 0 || moving.orders > 0 || moving.creOrders > 0 || moving.cres > 0;

  return {
    id: target.id,
    name: target.name,
    role: target.role,
    destination: null,
    needsChoice: hasWork,
    moving,
    candidates,
    blockedReason:
      blockedReason ??
      (hasWork && candidates.length === 0
        ? "There is no other active salesman to receive this work. Create one first."
        : null),
  };
}

/**
 * The account hierarchy, in one place.
 *
 * Every operation that takes access away from somebody - delete, deactivate,
 * and the reactivation that undoes a deactivation - has to answer to the same
 * three rules, so they live here rather than being restated per call site.
 * They are deliberately NOT in lib/permissions: that table grants a verb to a
 * role, and these are rules about the *target* of the verb.
 */
type AccountVerb = "delete" | "deactivate" | "reactivate" | "edit";

const PAST_TENSE: Record<AccountVerb, string> = {
  delete: "deleted",
  deactivate: "deactivated",
  reactivate: "reactivated",
  edit: "edited",
};

function accountActionBlockReason(
  actor: SessionUser,
  target: { id: string; role: Role },
  verb: AccountVerb,
): string | null {
  if (target.role === "OWNER") {
    return `The owner account cannot be ${PAST_TENSE[verb]}.`;
  }
  if (target.id === actor.id) {
    return `You cannot ${verb} your own account.`;
  }
  if (target.role === "ADMIN" && !can(actor.role, "user.create.admin")) {
    return `Only the owner can ${verb} an admin.`;
  }
  return null;
}

function deletionBlockReason(
  actor: SessionUser,
  target: { id: string; role: Role },
): string | null {
  return accountActionBlockReason(actor, target, "delete");
}

/**
 * Delete an account and move every piece of work it was holding.
 *
 * The rules, in one transaction so there is never an instant where a lead or
 * an order has no owner:
 *
 *   CRE      -> everything goes to the salesman that CRE was assigned to.
 *               Their orders lose the CRE and return to that salesman;
 *               their leads change owner. Nothing else is touched.
 *
 *   SALESMAN -> the caller names another salesman, and the leads, the orders
 *               AND the CREs all move there together, so the CREs keep
 *               working the same orders under their new salesman.
 *
 * In both cases stage, status and payment history are copied across
 * untouched. `stage` in particular is deliberately NOT normalised: an order
 * that was WITH_CRE stays WITH_CRE, exactly as specified, and the UI shows it
 * as awaiting re-handover because its CRE is gone.
 */
export async function deleteUser(
  actor: SessionUser,
  targetId: string,
  options: { transferToId?: string | null } = {},
): Promise<{ movedTo: string | null; moved: DeletionPreview["moving"] }> {
  requirePermission(actor.role, "user.delete");

  return prisma.$transaction(async (tx) => {
    // Scoped: an id arriving from a form must not be able to name an account
    // in another organisation.
    const target = await tx.user.findFirst({
      where: { id: targetId, orgId: actor.orgId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
      },
    });
    if (!target) throw new NotFoundError("That account");

    const blocked = deletionBlockReason(actor, target);
    if (blocked) throw new ConflictError(blocked);

    // ---- work out the destination ---------------------------------------
    //
    // Only a salesman needs one. A CRE holds nothing that belongs to them:
    // their orders are already credited to a salesman and only lose their
    // CRE, and they own no leads. Asking which of their salesmen should
    // "receive" the work would be asking a question with no right answer now
    // that there can be more than one.
    let destination: { id: string; name: string } | null = null;

    if (target.role !== "CRE") {
      const counts = await countWork(tx, target.id);
      const hasWork =
        counts.leads > 0 || counts.orders > 0 || counts.creOrders > 0 || counts.cres > 0;

      if (hasWork) {
        if (!options.transferToId) {
          throw new ValidationError(
            `${target.name} still holds work. Choose the salesman who should receive it.`,
            { transferToId: "Choose a salesman to receive the work" },
          );
        }
        destination = await requireSalesman(
          tx,
          actor.orgId,
          options.transferToId,
          target.id,
        );
      }
    }

    // ---- move everything -------------------------------------------------
    const moved = { leads: 0, orders: 0, creOrders: 0, cres: 0 };

    if (target.role === "CRE") {
      // The order keeps the salesman it was credited to and simply loses its
      // CRE. salesmanId is deliberately untouched: it used to be rewritten to
      // this CRE's manager, which was a no-op in the normal case but silently
      // transferred the order to a different salesman whenever the CRE had
      // been reassigned after the order was placed.
      const creOrders = await tx.order.updateMany({
        where: { creId: target.id },
        data: { creId: null },
      });
      moved.creOrders = creOrders.count;
    } else if (destination) {
      const leads = await tx.lead.updateMany({
        where: { ownerId: target.id },
        data: { ownerId: destination.id },
      });
      moved.leads = leads.count;

      const orders = await tx.order.updateMany({
        where: { salesmanId: target.id },
        data: { salesmanId: destination.id },
      });
      moved.orders = orders.count;

      // Orders this person happened to hold as a CRE (only possible after an
      // earlier transfer) also return to the destination salesman.
      const heldAsCre = await tx.order.updateMany({
        where: { creId: target.id },
        data: { creId: null, salesmanId: destination.id },
      });
      moved.creOrders = heldAsCre.count;

      // Quotations credited to this salesman follow their orders, otherwise
      // SetNull would leave them with no salesman and no name on the PDF.
      await tx.quotation.updateMany({
        where: { salesmanId: target.id },
        data: { salesmanId: destination.id },
      });

      // The CREs move with the work, so they keep serving the same orders. A
      // CRE that already works for the destination would collide on the
      // unique (creId, salesmanId) pair, so those links are dropped rather
      // than duplicated.
      const links = await tx.creSalesman.findMany({
        where: { salesmanId: target.id },
        select: { creId: true },
      });
      const existing = await tx.creSalesman.findMany({
        where: {
          salesmanId: destination.id,
          creId: { in: links.map((link) => link.creId) },
        },
        select: { creId: true },
      });
      const alreadyLinked = new Set(existing.map((link) => link.creId));

      await tx.creSalesman.deleteMany({ where: { salesmanId: target.id } });

      const movable = links.filter((link) => !alreadyLinked.has(link.creId));
      if (movable.length > 0) {
        await tx.creSalesman.createMany({
          data: movable.map((link) => ({
            orgId: actor.orgId,
            creId: link.creId,
            salesmanId: destination.id,
          })),
        });
      }
      moved.cres = links.length;
    }

    // ---- prove nothing was orphaned --------------------------------------
    const leftBehind = await countWork(tx, target.id);
    if (
      leftBehind.leads > 0 ||
      leftBehind.orders > 0 ||
      leftBehind.creOrders > 0 ||
      leftBehind.cres > 0
    ) {
      // Rolls the whole transaction back. Better to refuse than to orphan.
      throw new ConflictError(
        "Some of this account's work could not be transferred. Nothing was deleted.",
      );
    }

    const summary = destination
      ? `${moved.leads} lead(s), ${moved.orders + moved.creOrders} order(s) and ${moved.cres} CRE(s) moved to ${destination.name}`
      : "no leads, orders or CREs to move";

    await audit(tx, {
      orgId: actor.orgId,
      action: "user.delete",
      actorId: actor.id,
      targetType: "User",
      targetId: target.id,
      detail: `${actor.name} deleted ${ROLE_LABEL[target.role]} ${target.name} (${target.email}): ${summary}. Stage, status and payment history were preserved.`,
    });

    // Sessions cascade, so the account loses access the instant this commits.
    await tx.user.delete({ where: { id: target.id } });

    return { movedTo: destination?.name ?? null, moved };
  });
}

async function requireSalesman(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  orgId: string,
  salesmanId: string,
  excludeId: string,
): Promise<{ id: string; name: string }> {
  if (salesmanId === excludeId) {
    throw new ValidationError("Pick somebody other than the account you are deleting.", {
      transferToId: "Choose a different salesman",
    });
  }
  // Work can only ever be handed to somebody in the same organisation.
  const salesman = await tx.user.findFirst({
    where: { id: salesmanId, role: "SALESMAN", isActive: true, orgId },
    select: { id: true, name: true },
  });
  if (!salesman) {
    throw new ValidationError("Pick an active salesman to receive the work.", {
      transferToId: "That salesman is not available",
    });
  }
  return salesman;
}

async function countWork(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  userId: string,
): Promise<DeletionPreview["moving"]> {
  const [leads, orders, creOrders, cres] = await Promise.all([
    tx.lead.count({ where: { ownerId: userId } }),
    tx.order.count({ where: { salesmanId: userId } }),
    tx.order.count({ where: { creId: userId } }),
    tx.creSalesman.count({ where: { salesmanId: userId } }),
  ]);
  return { leads, orders, creOrders, cres };
}
