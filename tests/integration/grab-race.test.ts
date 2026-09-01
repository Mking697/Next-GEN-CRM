import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  TEST_DB,
  assertSchema,
  disconnect,
  makeLead,
  makeUser,
  resetDatabase,
  sessionFor,
  skipWithoutDb,
} from "../helpers/db";
import { grabLead } from "@/server/leads";
import { prisma } from "@/lib/db";

/**
 * The grab is the one place two salesmen genuinely race for the same row.
 *
 * grabLead relies on `updateMany({ where: { id, ownerId: null } })` and trusts
 * nothing but the returned count - Postgres decides the winner. That claim is
 * only worth anything if it is tested against Postgres, with two calls really
 * in flight at once.
 */

describe("grabLead, under contention", { skip: skipWithoutDb }, () => {
  before(async () => {
    assert.ok(TEST_DB);
    await assertSchema();
  });
  beforeEach(resetDatabase);
  after(disconnect);

  test("two salesmen grabbing at the same instant: exactly one wins", async () => {
    const [a, b] = await Promise.all([makeUser("SALESMAN"), makeUser("SALESMAN")]);
    const [sessionA, sessionB] = await Promise.all([sessionFor(a.id), sessionFor(b.id)]);
    const lead = await makeLead();

    const results = await Promise.allSettled([
      grabLead(sessionA, lead.id),
      grabLead(sessionB, lead.id),
    ]);

    const won = results.filter((r) => r.status === "fulfilled").length;
    assert.equal(won, 1, "exactly one grab must succeed");

    const stored = await prisma.lead.findUniqueOrThrow({
      where: { id: lead.id },
      select: { ownerId: true, grabbedAt: true },
    });
    assert.ok(stored.ownerId === a.id || stored.ownerId === b.id);
    assert.ok(stored.grabbedAt, "the winner's grab must be timestamped");
  });

  test("ten salesmen on one lead still leaves one owner", async () => {
    const users = await Promise.all(
      Array.from({ length: 10 }, () => makeUser("SALESMAN")),
    );
    const sessions = await Promise.all(users.map((u) => sessionFor(u.id)));
    const lead = await makeLead();

    const results = await Promise.allSettled(
      sessions.map((s) => grabLead(s, lead.id)),
    );

    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);

    const stored = await prisma.lead.findUniqueOrThrow({
      where: { id: lead.id },
      select: { ownerId: true },
    });
    assert.ok(users.some((u) => u.id === stored.ownerId));
  });

  test("an already-owned lead cannot be grabbed away", async () => {
    const owner = await makeUser("SALESMAN");
    const other = await makeUser("SALESMAN");
    const lead = await makeLead({ ownerId: owner.id });

    const session = await sessionFor(other.id);
    await assert.rejects(() => grabLead(session, lead.id));

    const stored = await prisma.lead.findUniqueOrThrow({
      where: { id: lead.id },
      select: { ownerId: true },
    });
    assert.equal(stored.ownerId, owner.id, "the original owner must be untouched");
  });

  test("the winner gets exactly one GRAB activity, not one per attempt", async () => {
    const [a, b] = await Promise.all([makeUser("SALESMAN"), makeUser("SALESMAN")]);
    const [sessionA, sessionB] = await Promise.all([sessionFor(a.id), sessionFor(b.id)]);
    const lead = await makeLead();

    await Promise.allSettled([
      grabLead(sessionA, lead.id),
      grabLead(sessionB, lead.id),
    ]);

    const activities = await prisma.leadActivity.count({
      where: { leadId: lead.id, kind: "GRAB" },
    });
    assert.equal(activities, 1);
  });
});
