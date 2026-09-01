-- Whoever runs this software, as opposed to whoever uses it.
--
-- Deliberately not a Role on "User". A user belongs to exactly one
-- organisation and every query about one is filtered by that, with no branch
-- anywhere that can turn the filter off - which is the only reason the
-- isolation is worth believing. A role that skipped it would put the hole
-- back, and every query written afterwards would depend on nobody reaching it
-- by accident.
--
-- So this is a separate identity with a separate session table, reaching
-- customer data by two explicit routes: the platform console, whose queries
-- say out loud that they read across organisations, and impersonation, which
-- issues an ordinary scoped session inside one tenant and leaves a trail.

CREATE TABLE "PlatformAdmin" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformAdmin_email_key" ON "PlatformAdmin"("email");

CREATE TABLE "PlatformSession" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ip" TEXT,
    CONSTRAINT "PlatformSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatformSession_tokenHash_key" ON "PlatformSession"("tokenHash");
CREATE INDEX "PlatformSession_adminId_idx" ON "PlatformSession"("adminId");
CREATE INDEX "PlatformSession_expiresAt_idx" ON "PlatformSession"("expiresAt");

ALTER TABLE "PlatformSession" ADD CONSTRAINT "PlatformSession_adminId_fkey"
    FOREIGN KEY ("adminId") REFERENCES "PlatformAdmin"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Which administrator opened this workspace, when one did. The session is
-- otherwise completely ordinary - same scope clauses, same permissions, same
-- organisation - so support happens inside a tenant rather than through a hole
-- in the boundary. This column is what puts the banner on screen and the row
-- in the audit trail.
ALTER TABLE "Session" ADD COLUMN "impersonatedById" TEXT;
CREATE INDEX "Session_impersonatedById_idx" ON "Session"("impersonatedById");
ALTER TABLE "Session" ADD CONSTRAINT "Session_impersonatedById_fkey"
    FOREIGN KEY ("impersonatedById") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Neither table belongs to a tenant, so neither gets a row-level-security
-- policy. A restricted reporting role has no business reading either, and the
-- control for that is withholding the SELECT grant rather than a policy that
-- would have no organisation to key on.
