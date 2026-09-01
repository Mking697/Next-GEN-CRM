-- Give the remaining quotations a salesman.
--
-- The first backfill resolved Quotation.salesmanId as
-- `COALESCE(lead.ownerId, cre.managerId)`, which is everything the old schema
-- could express. It leaves out the case the new rule handles: a quotation
-- raised without a lead by somebody who is not a CRE. An owner, admin or
-- salesman issues a quotation in their own name, which is exactly what
-- createQuotation() now records, and without this those rows would keep
-- printing "Sales person: -" on the PDF forever.
--
-- Deliberately not applied to a CRE: a CRE-built quotation belongs to the
-- salesman they were working as, never to the CRE, and if that could not be
-- resolved then leaving it null is the honest answer.

UPDATE "Quotation" q
SET "salesmanId" = q."creId"
FROM "User" u
WHERE u."id" = q."creId"
  AND q."salesmanId" IS NULL
  AND u."role" <> 'CRE';
