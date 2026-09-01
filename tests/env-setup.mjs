/**
 * A minimal, valid environment for the unit tests.
 *
 * lib/env validates lazily and memoises, so this has to run before any module
 * under test touches `env`. It is wired in as a `--import` on the test script
 * for exactly that reason.
 *
 * None of these values reach a network. The database URLs are never connected
 * to: every module tested here is pure, and anything that would open a
 * connection belongs in an integration test with a real database.
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
