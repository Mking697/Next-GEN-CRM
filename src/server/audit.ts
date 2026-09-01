import "server-only";
import type { Db } from "@/lib/db";
import { prisma } from "@/lib/db";

/**
 * Append-only record of the destructive operations.
 *
 * Deleting an account moves other people's work around, and "nothing is lost"
 * is only a credible claim if there is a record saying where everything went.
 * Written inside the same transaction as the move, so the trail cannot exist
 * without the move or the move without the trail.
 */

export async function audit(
  db: Db,
  entry: {
    /** Which organisation's trail this belongs on. */
    orgId: string;
    action: string;
    detail: string;
    actorId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
  },
): Promise<void> {
  await db.auditEvent.create({
    data: {
      orgId: entry.orgId,
      action: entry.action,
      detail: entry.detail,
      actorId: entry.actorId ?? null,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
    },
  });
}

export interface AuditRow {
  id: string;
  action: string;
  detail: string;
  actorName: string | null;
  createdAt: Date;
}

export async function listAudit(orgId: string, limit = 100): Promise<AuditRow[]> {
  const rows = await prisma.auditEvent.findMany({
    where: { orgId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      action: true,
      detail: true,
      createdAt: true,
      actor: { select: { name: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    detail: row.detail,
    actorName: row.actor?.name ?? null,
    createdAt: row.createdAt,
  }));
}
