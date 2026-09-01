-- Remove the Google Sheets and Drive mirror.
--
-- Quotations were written to Postgres first and pushed to a Sheet and a Drive
-- folder afterwards. That mirror is gone: the PDF is already generated on
-- demand from the live rows, so the Drive copy was a second answer to a
-- question that already had one, and a single global service account was never
-- going to work once more than one company uses this.
--
-- The Clientdata importer goes with it. It existed to migrate one company off
-- an Apps Script system, which is finished; a CSV upload is the right shape for
-- that job from here on. User.sheetAlias and Company.sheetSalesExecutive only
-- ever served that importer's name matching.

ALTER TABLE "Quotation" DROP COLUMN IF EXISTS "pdfUrl";
ALTER TABLE "Quotation" DROP COLUMN IF EXISTS "sheetRow";
ALTER TABLE "Quotation" DROP COLUMN IF EXISTS "sheetSyncedAt";
ALTER TABLE "Quotation" DROP COLUMN IF EXISTS "sheetError";

DROP INDEX IF EXISTS "Quotation_sheetStatus_idx";
ALTER TABLE "Quotation" DROP COLUMN IF EXISTS "sheetStatus";
DROP TYPE IF EXISTS "MirrorStatus";

DROP INDEX IF EXISTS "User_sheetAlias_idx";
ALTER TABLE "User" DROP COLUMN IF EXISTS "sheetAlias";

ALTER TABLE "Company" DROP COLUMN IF EXISTS "sheetSalesExecutive";
