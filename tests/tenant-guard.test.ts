import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "@/lib/tenant-guard";

/**
 * The guard's decision is a pure function of the model, the operation and the
 * arguments, so it can be pinned down without a database. Worth doing: the
 * interesting cases are the ones where a clause LOOKS scoped and is not.
 */

const ok = (model: string, op: string, args: unknown) =>
  inspect(model, op, args).ok;

describe("what counts as naming an organisation", () => {
  test("a plain orgId does", () => {
    assert.equal(ok("Lead", "findMany", { where: { orgId: "o1" } }), true);
  });

  test("a composite unique does", () => {
    assert.equal(
      ok("User", "findFirst", { where: { orgId_email: { orgId: "o1", email: "a@b.c" } } }),
      true,
    );
  });

  test("a relation filter on org does", () => {
    assert.equal(
      ok("User", "findMany", { where: { org: { slug: "acme" } } }),
      true,
    );
  });

  test("nested inside AND does, because scope.ts composes that way", () => {
    assert.equal(
      ok("Lead", "findFirst", {
        where: { AND: [{ id: "x" }, { orgId: "o1" }] },
      }),
      true,
    );
    assert.equal(
      ok("Lead", "findFirst", {
        where: { AND: [{ id: "x" }, { AND: [{ orgId: "o1" }] }] },
      }),
      true,
    );
  });

  /**
   * The case worth having a test for. `{ OR: [scoped, unscoped] }` reads as
   * safe at a glance and is not: the second branch still matches rows from
   * every organisation, so the union does too.
   */
  test("a top-level OR does NOT, even when one branch names it", () => {
    assert.equal(
      ok("Order", "findMany", {
        where: { OR: [{ orgId: "o1" }, { salesmanId: "u1" }] },
      }),
      false,
    );
  });

  test("no where clause at all does not", () => {
    assert.equal(ok("Lead", "count", {}), false);
    assert.equal(ok("Lead", "count", undefined), false);
  });

  test("an orgId that is not a string does not", () => {
    // `{ orgId: { not: null } }` matches every organisation, not one.
    assert.equal(ok("Lead", "findMany", { where: { orgId: { not: null } } }), false);
  });
});

describe("which calls are inspected at all", () => {
  test("set operations are", () => {
    for (const op of [
      "findFirst",
      "findFirstOrThrow",
      "findMany",
      "updateMany",
      "deleteMany",
      "count",
      "aggregate",
      "groupBy",
    ]) {
      assert.equal(ok("Lead", op, { where: {} }), false, `${op} should be checked`);
    }
  });

  test("by-key operations are not", () => {
    // A primary key reaches one row, and reaching the wrong one needs an id
    // the caller should not have - which is what the set operations above are
    // guarding against in the first place.
    for (const op of ["findUnique", "findUniqueOrThrow", "update", "delete"]) {
      assert.equal(ok("Lead", op, { where: { id: "x" } }), true, `${op} should be allowed`);
    }
  });

  test("models that belong to nobody are not", () => {
    assert.equal(ok("Organisation", "findMany", { where: {} }), true);
    assert.equal(ok("Session", "deleteMany", { where: { userId: "u1" } }), true);
  });
});

describe("writes have to carry an organisation", () => {
  test("a create without one is refused", () => {
    assert.equal(ok("Lead", "create", { data: { personName: "X" } }), false);
    assert.equal(ok("Lead", "create", { data: { orgId: "o1", personName: "X" } }), true);
  });

  test("createMany checks every row, not just the first", () => {
    assert.equal(
      ok("LeadActivity", "createMany", {
        data: [{ orgId: "o1", message: "a" }, { message: "b" }],
      }),
      false,
    );
    assert.equal(
      ok("LeadActivity", "createMany", {
        data: [{ orgId: "o1", message: "a" }, { orgId: "o1", message: "b" }],
      }),
      true,
    );
  });

  test("a nested connect counts", () => {
    assert.equal(
      ok("Lead", "create", { data: { org: { connect: { id: "o1" } }, personName: "X" } }),
      true,
    );
  });

  test("upsert is checked on the row it might write", () => {
    // Only the create half. The where half of an upsert is a unique key, so
    // it lands on one row like the other by-key operations do.
    assert.equal(
      ok("SyncState", "upsert", {
        where: { orgId_key: { orgId: "o1", key: "indiamart" } },
        create: { orgId: "o1", key: "indiamart" },
        update: {},
      }),
      true,
    );
    assert.equal(
      ok("SyncState", "upsert", {
        where: { orgId_key: { orgId: "o1", key: "indiamart" } },
        create: { key: "indiamart" },
        update: {},
      }),
      false,
    );
  });
});
