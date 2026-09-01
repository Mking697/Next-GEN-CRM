-- Row-level security on every table that belongs to an organisation.
--
-- WHAT THIS IS FOR, precisely - because it is easy to assume it does more.
--
-- It does NOT gate the application's own queries. RLS reads the tenant from a
-- connection-level setting, and on a shared connection pool that setting can
-- only be bound safely inside a transaction. Wrapping every read in a
-- transaction to set it would double the round trips on an application that
-- was deliberately tuned to reduce them. The application's boundary is
-- server/scope.ts, which applies the filter in one place that cannot be
-- forgotten, and the tenant-isolation tests are what prove it.
--
-- What this IS for is everything that does not come through the application:
-- a psql session, a BI tool, an analytics job, a second service, a credential
-- that leaks. Those connect as a restricted role, and this makes it impossible
-- for that role to read past one organisation however the query is written.
--
-- The application keeps working untouched because it connects as the table
-- owner, and an owner bypasses RLS unless FORCE ROW LEVEL SECURITY is set.
-- That is deliberate, not an oversight: see above for why forcing it would
-- cost more than it buys here.
--
-- To create the restricted role (once, by an operator - roles are
-- cluster-level, so they do not belong in a migration):
--
--   CREATE ROLE crm_reader LOGIN PASSWORD '...';
--   GRANT CONNECT ON DATABASE <db> TO crm_reader;
--   GRANT USAGE ON SCHEMA public TO crm_reader;
--   GRANT SELECT ON ALL TABLES IN SCHEMA public TO crm_reader;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT SELECT ON TABLES TO crm_reader;
--
-- and then, on every connection that role opens:
--
--   SET app.org_id = '<the organisation id>';
--
-- Without that setting the policy matches nothing, which is the safe
-- direction: a tool that forgets to say who it is sees an empty database
-- rather than everybody's.

-- ---------------------------------------------------------------------------
-- The tenant the current connection is allowed to see
-- ---------------------------------------------------------------------------

-- STABLE, so the planner evaluates it once per query rather than per row.
-- The `true` argument makes current_setting return NULL instead of raising
-- when the setting has never been set, which is what lets an unconfigured
-- connection see nothing instead of erroring confusingly.
CREATE OR REPLACE FUNCTION current_org_id() RETURNS TEXT AS $$
  SELECT nullif(current_setting('app.org_id', true), '');
$$ LANGUAGE SQL STABLE;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'User', 'CreSalesman', 'Lead', 'LeadActivity', 'Company', 'Contact',
        'Order', 'Payment', 'Quotation', 'QuotationRevision', 'QuotationItem',
        'SyncState', 'AuditEvent'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_tenant_isolation', t);
        EXECUTE format(
            'CREATE POLICY %I ON %I USING ("orgId" = current_org_id())',
            t || '_tenant_isolation', t
        );
    END LOOP;
END $$;

-- Organisation itself: a restricted connection may see only its own row, so a
-- tool cannot enumerate the customer list.
ALTER TABLE "Organisation" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Organisation_tenant_isolation" ON "Organisation";
CREATE POLICY "Organisation_tenant_isolation" ON "Organisation"
    USING ("id" = current_org_id());

-- Session is deliberately left alone. It carries no orgId - it is how the
-- application discovers which organisation a request belongs to - and a
-- restricted reporting role has no business reading session tokens at all.
-- Withholding the SELECT grant is the right control there, not a policy.
