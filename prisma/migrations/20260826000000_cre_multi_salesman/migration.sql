-- One CRE can now serve more than one salesman.
--
-- User.managerId held exactly one, which made two things impossible: a CRE
-- shared between salesmen, and a straight answer to "whose quotation is this?"
-- when the CRE serves several. The link becomes a join table, and a quotation
-- starts carrying the salesman it was raised for.
--
-- EXPAND ONLY. Everything here is additive, and User.managerId is left in
-- place even though nothing reads it any more. That is what makes this
-- deployable without downtime: the previous build keeps serving while the new
-- one compiles, and it reads managerId on every request. The column, its
-- index and its foreign key are dropped in a later migration, once nothing
-- old is still running. See the note on User.managerId in schema.prisma.
--
-- Order matters below: both backfills read User.managerId.

-- CreateTable
CREATE TABLE "CreSalesman" (
    "id" TEXT NOT NULL,
    "creId" TEXT NOT NULL,
    "salesmanId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreSalesman_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreSalesman_creId_salesmanId_key" ON "CreSalesman"("creId", "salesmanId");

-- CreateIndex
CREATE INDEX "CreSalesman_creId_idx" ON "CreSalesman"("creId");

-- CreateIndex
CREATE INDEX "CreSalesman_salesmanId_idx" ON "CreSalesman"("salesmanId");

-- AddForeignKey
ALTER TABLE "CreSalesman" ADD CONSTRAINT "CreSalesman_creId_fkey" FOREIGN KEY ("creId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreSalesman" ADD CONSTRAINT "CreSalesman_salesmanId_fkey" FOREIGN KEY ("salesmanId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: every CRE that reports to a salesman today gets exactly one row,
-- so nobody loses or gains visibility the moment this lands.
INSERT INTO "CreSalesman" ("id", "creId", "salesmanId", "createdAt")
SELECT gen_random_uuid()::text, "id", "managerId", CURRENT_TIMESTAMP
FROM "User"
WHERE "managerId" IS NOT NULL
ON CONFLICT ("creId", "salesmanId") DO NOTHING;

-- AlterTable
ALTER TABLE "Quotation" ADD COLUMN "salesmanId" TEXT;

-- Backfill: the lead owner where there is a lead, otherwise the salesman the
-- CRE reported to at the time. That reproduces exactly what
-- placeOrderFromQuotation() used to derive on the fly.
UPDATE "Quotation" q
SET "salesmanId" = COALESCE(
  (SELECT l."ownerId"   FROM "Lead" l WHERE l."id" = q."leadId"),
  (SELECT u."managerId" FROM "User" u WHERE u."id" = q."creId")
);

-- CreateIndex
CREATE INDEX "Quotation_salesmanId_idx" ON "Quotation"("salesmanId");

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_salesmanId_fkey" FOREIGN KEY ("salesmanId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
