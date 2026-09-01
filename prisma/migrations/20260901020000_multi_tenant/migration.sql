-- Multi-tenancy: every row that belongs to somebody now names the
-- organisation it belongs to.
--
-- This is written to be correct in both directions. On a fresh database there
-- is nothing to move, and no organisation is invented - the seed creates the
-- first one along with its owner. On a database that has been running as a
-- single tenant, every existing row is adopted by one organisation created
-- here, so nothing is orphaned and nothing is lost.
--
-- The unique keys are the dangerous part. Lead.phoneKey, Lead.emailKey,
-- Order.orderNo, Quotation.quoteNo and User.email were all globally unique.
-- Left that way, one organisation capturing a lead would permanently stop
-- every other organisation from ever capturing the same person, and no two
-- organisations could both have an ORD-2026-0001. Worse, the lead failure is
-- silent: the customer simply never appears. Each becomes composite on orgId.

-- ---------------------------------------------------------------------------
-- 1. The tenant table
-- ---------------------------------------------------------------------------

CREATE TABLE "Organisation" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "address" TEXT,
    "gstin" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "logo" BYTEA,
    "logoMime" TEXT,
    "bankBeneficiary" TEXT,
    "bankName" TEXT,
    "bankAccount" TEXT,
    "bankIfsc" TEXT,
    "bankAccountType" TEXT,
    "bankBranch" TEXT,
    "quotationNumberStart" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Organisation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Organisation_slug_key" ON "Organisation"("slug");
CREATE INDEX "Organisation_isActive_idx" ON "Organisation"("isActive");

-- ---------------------------------------------------------------------------
-- 2. Add orgId everywhere, nullable for now so the backfill can run
-- ---------------------------------------------------------------------------

ALTER TABLE "User"              ADD COLUMN "orgId" TEXT;
ALTER TABLE "CreSalesman"       ADD COLUMN "orgId" TEXT;
ALTER TABLE "Lead"              ADD COLUMN "orgId" TEXT;
ALTER TABLE "LeadActivity"      ADD COLUMN "orgId" TEXT;
ALTER TABLE "Company"           ADD COLUMN "orgId" TEXT;
ALTER TABLE "Contact"           ADD COLUMN "orgId" TEXT;
ALTER TABLE "Order"             ADD COLUMN "orgId" TEXT;
ALTER TABLE "Payment"           ADD COLUMN "orgId" TEXT;
ALTER TABLE "Quotation"         ADD COLUMN "orgId" TEXT;
ALTER TABLE "QuotationRevision" ADD COLUMN "orgId" TEXT;
ALTER TABLE "QuotationItem"     ADD COLUMN "orgId" TEXT;
ALTER TABLE "SyncState"         ADD COLUMN "orgId" TEXT;
ALTER TABLE "AuditEvent"        ADD COLUMN "orgId" TEXT;

-- ---------------------------------------------------------------------------
-- 3. Adopt whatever is already here
--
-- Only when there is something to adopt. A fresh database gets no
-- organisation from this migration; the seed makes the first one.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    default_org TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM "User") THEN
        default_org := 'org_' || replace(gen_random_uuid()::text, '-', '');

        INSERT INTO "Organisation" ("id", "slug", "name", "updatedAt")
        VALUES (default_org, 'default', 'Default organisation', CURRENT_TIMESTAMP);

        UPDATE "User"              SET "orgId" = default_org;
        UPDATE "CreSalesman"       SET "orgId" = default_org;
        UPDATE "Lead"              SET "orgId" = default_org;
        UPDATE "LeadActivity"      SET "orgId" = default_org;
        UPDATE "Company"           SET "orgId" = default_org;
        UPDATE "Contact"           SET "orgId" = default_org;
        UPDATE "Order"             SET "orgId" = default_org;
        UPDATE "Payment"           SET "orgId" = default_org;
        UPDATE "Quotation"         SET "orgId" = default_org;
        UPDATE "QuotationRevision" SET "orgId" = default_org;
        UPDATE "QuotationItem"     SET "orgId" = default_org;
        UPDATE "SyncState"         SET "orgId" = default_org;
        UPDATE "AuditEvent"        SET "orgId" = default_org;
    ELSE
        -- No users means no data worth keeping. Anything left behind would be
        -- unreachable rows from an abandoned setup, and they cannot be
        -- attributed to anybody, so they go rather than block the NOT NULL.
        DELETE FROM "CreSalesman";
        DELETE FROM "Payment";
        DELETE FROM "QuotationItem";
        DELETE FROM "QuotationRevision";
        DELETE FROM "Order";
        DELETE FROM "Quotation";
        DELETE FROM "LeadActivity";
        DELETE FROM "Lead";
        DELETE FROM "Contact";
        DELETE FROM "Company";
        DELETE FROM "SyncState";
        DELETE FROM "AuditEvent";
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Now it can be required
-- ---------------------------------------------------------------------------

ALTER TABLE "User"              ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "CreSalesman"       ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "Lead"              ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "LeadActivity"      ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "Company"           ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "Contact"           ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "Order"             ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "Payment"           ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "Quotation"         ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "QuotationRevision" ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "QuotationItem"     ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "SyncState"         ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "AuditEvent"        ALTER COLUMN "orgId" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. The unique keys, rebuilt per organisation
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS "User_email_key";
CREATE UNIQUE INDEX "User_orgId_email_key" ON "User"("orgId", "email");

DROP INDEX IF EXISTS "Lead_phoneKey_key";
DROP INDEX IF EXISTS "Lead_emailKey_key";
DROP INDEX IF EXISTS "Lead_source_externalId_key";
CREATE UNIQUE INDEX "Lead_orgId_phoneKey_key" ON "Lead"("orgId", "phoneKey");
CREATE UNIQUE INDEX "Lead_orgId_emailKey_key" ON "Lead"("orgId", "emailKey");
CREATE UNIQUE INDEX "Lead_orgId_source_externalId_key" ON "Lead"("orgId", "source", "externalId");

DROP INDEX IF EXISTS "Order_orderNo_key";
CREATE UNIQUE INDEX "Order_orgId_orderNo_key" ON "Order"("orgId", "orderNo");

DROP INDEX IF EXISTS "Quotation_quoteNo_key";
CREATE UNIQUE INDEX "Quotation_orgId_quoteNo_key" ON "Quotation"("orgId", "quoteNo");

-- SyncState is keyed by the job name. Each organisation polls with its own
-- credentials on its own five-minute clock, so the key is now composite.
ALTER TABLE "SyncState" DROP CONSTRAINT "SyncState_pkey";
ALTER TABLE "SyncState" ADD CONSTRAINT "SyncState_pkey" PRIMARY KEY ("orgId", "key");

-- ---------------------------------------------------------------------------
-- 6. Indexes and foreign keys
-- ---------------------------------------------------------------------------

CREATE INDEX "User_orgId_idx"              ON "User"("orgId");
CREATE INDEX "CreSalesman_orgId_idx"       ON "CreSalesman"("orgId");
CREATE INDEX "Lead_orgId_idx"              ON "Lead"("orgId");
CREATE INDEX "LeadActivity_orgId_idx"      ON "LeadActivity"("orgId");
CREATE INDEX "Company_orgId_idx"           ON "Company"("orgId");
CREATE INDEX "Contact_orgId_idx"           ON "Contact"("orgId");
CREATE INDEX "Order_orgId_idx"             ON "Order"("orgId");
CREATE INDEX "Payment_orgId_idx"           ON "Payment"("orgId");
CREATE INDEX "Quotation_orgId_idx"         ON "Quotation"("orgId");
CREATE INDEX "QuotationRevision_orgId_idx" ON "QuotationRevision"("orgId");
CREATE INDEX "QuotationItem_orgId_idx"     ON "QuotationItem"("orgId");
CREATE INDEX "AuditEvent_orgId_idx"        ON "AuditEvent"("orgId");

-- Cascade: deleting an organisation removes everything it owns. That is what
-- "delete my workspace" has to mean, and it is the only delete in this schema
-- allowed to destroy rather than transfer.
ALTER TABLE "User"              ADD CONSTRAINT "User_orgId_fkey"              FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreSalesman"       ADD CONSTRAINT "CreSalesman_orgId_fkey"       FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Lead"              ADD CONSTRAINT "Lead_orgId_fkey"              FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadActivity"      ADD CONSTRAINT "LeadActivity_orgId_fkey"      FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Company"           ADD CONSTRAINT "Company_orgId_fkey"           FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Contact"           ADD CONSTRAINT "Contact_orgId_fkey"           FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order"             ADD CONSTRAINT "Order_orgId_fkey"             FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment"           ADD CONSTRAINT "Payment_orgId_fkey"           FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Quotation"         ADD CONSTRAINT "Quotation_orgId_fkey"         FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuotationRevision" ADD CONSTRAINT "QuotationRevision_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "QuotationItem"     ADD CONSTRAINT "QuotationItem_orgId_fkey"     FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SyncState"         ADD CONSTRAINT "SyncState_orgId_fkey"         FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent"        ADD CONSTRAINT "AuditEvent_orgId_fkey"        FOREIGN KEY ("orgId") REFERENCES "Organisation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
