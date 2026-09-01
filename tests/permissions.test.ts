import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AuthorizationError,
  DATA_SCOPES,
  PERMISSION_GROUPS,
  PERMISSION_IDS,
  ROLES,
  SCOPE_KEYS,
  assertScopesAreReachable,
  can,
  creatableRoles,
  permissionsForRole,
  requirePermission,
  restrictionsForRole,
} from "@/lib/permissions";
import type { Role } from "@/generated/prisma/enums";

/**
 * The permission table's whole claim is that enforcement and the Guidebook
 * cannot disagree, because both read these same rows. That is a property of
 * the table, which means it can be checked here rather than trusted.
 */

describe("the guidebook cannot lie", () => {
  test("granted and not-granted partition every permission, for every role", () => {
    for (const role of ROLES) {
      const granted = permissionsForRole(role).flatMap((s) => s.items.map((i) => i.id));
      const denied = restrictionsForRole(role).map((i) => i.id);

      assert.equal(
        new Set([...granted, ...denied]).size,
        PERMISSION_IDS.length,
        `${role}: every permission must appear on exactly one of the two lists`,
      );
      assert.equal(
        granted.filter((id) => denied.includes(id)).length,
        0,
        `${role}: nothing may be both granted and denied`,
      );
    }
  });

  test("what the guidebook shows as granted is exactly what can() allows", () => {
    for (const role of ROLES) {
      for (const id of PERMISSION_IDS) {
        const shown = permissionsForRole(role)
          .flatMap((s) => s.items)
          .some((i) => i.id === id);
        assert.equal(
          shown,
          can(role, id),
          `${role} / ${id}: guidebook and enforcement disagree`,
        );
      }
    }
  });

  test("every permission belongs to a declared group", () => {
    const groups = new Set(PERMISSION_GROUPS.map((g) => g.id));
    for (const role of ROLES) {
      for (const item of restrictionsForRole(role)) {
        assert.ok(groups.has(item.group), `${item.id} is in unknown group ${item.group}`);
      }
    }
  });
});

describe("scopes are reachable", () => {
  /**
   * The deploy-time check /api/health runs. A role granted a non-NONE scope
   * without the permission that reads it would be shown a visibility rule the
   * queries never apply.
   */
  test("no role is given a scope it cannot use", () => {
    assert.deepEqual(assertScopesAreReachable(), []);
  });

  test("every role declares a scope for every collection", () => {
    for (const role of ROLES) {
      for (const key of SCOPE_KEYS) {
        assert.ok(
          DATA_SCOPES[role][key] !== undefined,
          `${role} has no scope declared for ${key}`,
        );
      }
    }
  });
});

describe("can / requirePermission", () => {
  test("requirePermission throws exactly when can() is false", () => {
    for (const role of ROLES) {
      for (const id of PERMISSION_IDS) {
        if (can(role, id)) {
          assert.doesNotThrow(() => requirePermission(role, id), `${role} / ${id}`);
        } else {
          assert.throws(() => requirePermission(role, id), AuthorizationError, `${role} / ${id}`);
        }
      }
    }
  });

  test("the error names the permission, for the denied page", () => {
    try {
      requirePermission("CRE", "user.delete");
      assert.fail("should have thrown");
    } catch (error) {
      assert.ok(error instanceof AuthorizationError);
      assert.equal(error.permission, "user.delete");
    }
  });
});

describe("the role rules the README states", () => {
  test("only the owner can create admins", () => {
    assert.deepEqual(creatableRoles("OWNER"), ["ADMIN", "SALESMAN", "CRE"]);
    assert.deepEqual(creatableRoles("ADMIN"), ["SALESMAN", "CRE"]);
    assert.deepEqual(creatableRoles("SALESMAN"), []);
    assert.deepEqual(creatableRoles("CRE"), []);
  });

  test("a CRE never sees the pool", () => {
    assert.equal(can("CRE", "pool.view"), false);
    assert.equal(can("CRE", "lead.grab"), false);
    assert.equal(DATA_SCOPES.CRE.pool, "NONE");
  });

  test("only a salesman grabs from the pool", () => {
    const grabbers = ROLES.filter((role: Role) => can(role, "lead.grab"));
    assert.deepEqual(grabbers, ["SALESMAN"]);
  });

  test("the owner is not a restricted role anywhere it matters", () => {
    // The owner is an admin plus admin creation. Anything denied to the owner
    // but allowed to an admin would be a mistake in the table.
    for (const id of PERMISSION_IDS) {
      if (can("ADMIN", id)) {
        assert.ok(can("OWNER", id), `owner should hold everything an admin does: ${id}`);
      }
    }
  });

  test("a CRE can record payments and close, but not delete accounts", () => {
    assert.equal(can("CRE", "payment.record"), true);
    assert.equal(can("CRE", "order.close"), true);
    assert.equal(can("CRE", "user.delete"), false);
    assert.equal(can("CRE", "user.create.staff"), false);
  });
});
