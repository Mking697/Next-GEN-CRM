-- The contract half of the CreSalesman change.
--
-- 20260826000000_cre_multi_salesman was expand-only: it added CreSalesman,
-- backfilled it from User.managerId, and deliberately left that column in
-- place because the previous release was still running and read it on every
-- request. This is the migration that note promised, run once nothing old is
-- left serving traffic.
--
-- Nothing in the application has read managerId since that release. The data
-- it held was copied into CreSalesman by the backfill, which is now the only
-- answer to "which salesmen does this CRE work for" - and unlike this column,
-- it can hold more than one.

ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_managerId_fkey";
DROP INDEX IF EXISTS "User_managerId_idx";
ALTER TABLE "User" DROP COLUMN IF EXISTS "managerId";
