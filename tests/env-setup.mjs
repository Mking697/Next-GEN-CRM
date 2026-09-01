/**
 * A minimal, valid environment for the tests.
 *
 * lib/env validates lazily and memoises, so this has to run before any module
 * under test touches `env`. It is wired in as a `--import` on the test script
 * for exactly that reason.
 *
 * Unit tests never open a connection, so the database URLs below are
 * placeholders. Integration tests do, and they only run when TEST_DATABASE_URL
 * names a real, disposable Postgres - see tests/helpers/db.ts.
 */

const defaults = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  APP_TIMEZONE: "Asia/Kolkata",
  DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  DIRECT_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  AUTH_SECRET: "test-secret-that-is-at-least-32-characters-long",
  QUOTATION_NUMBER_START: "20",
};

for (const [key, value] of Object.entries(defaults)) {
  if (!process.env[key]) process.env[key] = value;
}

/**
 * Point the app's own connection at the throwaway database.
 *
 * lib/db reads env.DATABASE_URL, and the code under test imports that module
 * rather than taking a client as an argument. Overriding here - before any of
 * it loads - is what lets the real functions run against a real Postgres
 * without threading a connection through every signature.
 *
 * TEST_DATABASE_URL is deliberately separate from DATABASE_URL: these tests
 * TRUNCATE every table, so pointing them at a development database by
 * forgetting one variable would destroy real data. You have to name the
 * throwaway one explicitly.
 */
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DIRECT_DATABASE_URL = process.env.TEST_DATABASE_URL;
}
