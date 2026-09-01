# Sales CRM

A lead-to-cash CRM for a sales team working IndiaMART enquiries, Meta Lead Ads
and walk-ins. Leads land in a shared pool, salesmen grab them, confirm orders,
and hand each order to a CRE who collects the money and closes it.

One Next.js 15 application. One process, one port. No separate API server, no
worker, no monorepo.

---

## Stack

| | |
|---|---|
| Runtime | Node.js 22, npm |
| Framework | Next.js 15 (App Router), React 19, TypeScript |
| Database | PostgreSQL on Neon, over the internet |
| ORM | Prisma 6 with `@prisma/adapter-pg` and `engineType = "client"` |
| Styling | Tailwind CSS v4 |
| Auth | Email and password, database-backed sessions |
| Money | Indian Rupees, stored as integer paise |

There is **no native query engine binary**. `engineType = "client"` plus the
pg driver adapter produces a pure JS/Wasm Prisma client, so the same artefact
runs on a Windows dev machine and on a Linux Node slot with no platform
targets to match and no postinstall build step.

---

## Local setup

```bash
npm ci
cp .env.example .env        # then fill it in - see the notes in that file
npx prisma migrate deploy   # or `npx prisma migrate dev` while developing
npm run seed                # creates the one owner account
npm run dev
```

Generate the two secrets the app needs:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"  # AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"  # CRON_SECRET
```

Sign in at `/login` with `SEED_OWNER_EMAIL` and `SEED_OWNER_PASSWORD`, change
the password from the account page, then clear `SEED_OWNER_PASSWORD` from the
environment. **Nobody can sign themselves up** - the seed creates the owner,
the owner creates admins, admins create salesmen and CREs.

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | `prisma generate`, `next build` (standalone), then copies `public/` and `.next/static` into the bundle |
| `npm start` | `node .next/standalone/server.js`, binds to `process.env.PORT` |
| `npm run db:deploy` | `prisma migrate deploy` against `DIRECT_DATABASE_URL` |
| `npm run seed` | Creates the owner. Idempotent: does nothing if an owner exists |
| `npm run typecheck` | `tsc --noEmit`, tests included |
| `npm test` | The test suite, on Node's built-in runner |
| `npm run reset-password` | Break glass: reset any account's password from the shell |
| `npm run platform-admin` | Create or reset the account that runs the platform |

---

## Deploying to Hostinger from GitHub

1. **Neon.** Create the project and copy both connection strings. The pooled
   one (host contains `-pooler`) is `DATABASE_URL`; the unpooled one is
   `DIRECT_DATABASE_URL`. Keep `sslmode=require` on both.

2. **Hostinger Node.js app.** Point it at the GitHub repository and set:

   | | |
   |---|---|
   | Node version | 22 |
   | Install command | `npm ci` |
   | Build command | `npm run build` |
   | Start command | `npm start` |

3. **Environment variables.** Add every variable from `.env.example` in the
   app's Environment Variables panel. Nothing in this codebase reads a
   hardcoded URL, key or secret; a missing required variable fails at boot
   with the variable named rather than starting half-configured.

   `APP_URL` must be the real public origin with no trailing slash - it is
   what marks cookies `secure` and what builds the Meta callback URL.

4. **Migrations.** Run once per deploy, from the Hostinger shell or a
   pipeline step:

   ```bash
   npx prisma migrate deploy
   ```

   This uses `DIRECT_DATABASE_URL`, never the pooler.

5. **Seed**, once, on the very first deploy:

   ```bash
   npm run seed
   ```

6. **Health check.** `GET /api/health` returns 200 when the environment
   parsed and Neon answered, 503 otherwise, and names what is wrong without
   echoing any secret.

`npm run build` never touches the database - every page reads cookies, so
every page is dynamic and nothing is prerendered. A build machine does not
need production credentials.

> **If a `.env` file exists when you build**, Next copies it into
> `.next/standalone/.env`. Real process environment variables still win over
> it, which is why the Hostinger panel is authoritative. But it does mean a
> locally-built bundle carries whatever was in your local `.env`, so never
> ship `.next/` from a dev machine - let the host build from the repository,
> where `.env` is gitignored and absent.

---

## Lead sources

### IndiaMART

Set `INDIAMART_CRM_KEY` (seller panel, Lead Manager, Import/Export Leads, CRM
API). Leave it empty to switch the integration off.

There is no worker process, so the schedule comes from outside. Point a cron
at the route every five minutes:

```
*/5 * * * * curl -fsS -X POST https://your-app/api/cron/indiamart \
  -H "Authorization: Bearer $CRON_SECRET"
```

**The five-minute rule is not delegated to that cron.** IndiaMART refuses more
than one call per five minutes, so the app checks `SyncState.lastRunAt` itself
and will not call the provider early. A cron that fires twice, a
misconfigured schedule, or somebody hitting the route by hand all get a 429
with `Retry-After` and no outbound request. The route also takes a lock with a
conditional `UPDATE`, so two overlapping invocations cannot both get through.
Admins can trigger the same job from the Lead sources page, under the same
rule.

### Meta Lead Ads

Set `META_APP_SECRET`, `META_VERIFY_TOKEN` and `META_PAGE_ACCESS_TOKEN` (the
last needs `leads_retrieval`). Leave `META_APP_SECRET` empty to switch the
integration off.

In the Meta app dashboard, add Webhooks, set the callback to
`<APP_URL>/api/webhooks/meta`, use `META_VERIFY_TOKEN` as the verify token,
and subscribe the page to the `leadgen` field. The exact URL is printed on the
Lead sources page.

Every POST is verified against `X-Hub-Signature-256` using the raw request
body before anything is parsed out of it. Meta sends a notification, not the
lead, so the app then fetches the field values from the Graph API.

### Manual

A form. Only a name is required.

### Deduplication

All three sources go through one function. A lead is matched on the provider's
own id first, then on a normalised phone (digits only, so `+91 98765 43210`
and `09876543210` are one person) and a lowercased email. Both normalised
columns carry a unique index, so two simultaneous webhook deliveries still
cannot create a second row. When a duplicate carries a field the stored lead
is missing, the gap is filled in; nothing already present is overwritten.

---

## Quotations

The pipeline is `Lead -> Quotation -> Order -> Payments -> Close`.

A salesman grabs a lead, works it, and hands it to one of their CREs. The CRE
builds the quotation on a spreadsheet-style grid where every cell is typed by
hand, sends it, and places the order once the customer accepts. The order value
is the quotation's payable amount, never a number re-typed, so the two
documents cannot disagree.

`Lead.creId` is deliberately separate from `Lead.ownerId`. The salesman stays
the owner, which is what keeps the Overview crediting their grab and keeps the
delete-and-transfer rules working unchanged.

### The grid

Enter moves down, arrows move between rows, Ctrl+Enter inserts a line, and a
block pasted straight out of Excel fills the cells it covers instead of
dropping tab characters into one input. Amounts are never typed: each line is
quantity times rate.

Quantities are integers in thousandths and rates are integers in paise, so a
line amount is one integer multiply and a single rounding step. The client
computes totals live for the person typing; the server recomputes them from the
same rows and only the server's answer is stored.

GST is charged on goods **plus freight** - the composite-supply treatment for
when the seller arranges transport. The base is printed next to the percentage
on screen and in the PDF so it is never a hidden assumption.

### The PDF

`GET /api/quotations/:id/pdf`, generated on demand with `@react-pdf/renderer`.
Nothing is stored, so a stale file can never disagree with the quotation on
screen.

Not HTML-to-PDF: that needs a headless Chromium, roughly 300MB of
platform-specific binary. This is 2MB of plain JavaScript.

> `pdfkit`, which it renders through, loads its font metrics with a computed
> `require('#standard-fonts/Helvetica')`. Next's file tracer cannot follow
> that, so `next.config.ts` force-includes those files. Without it every PDF
> render fails at runtime with MODULE_NOT_FOUND while the build stays green.

## Multi-tenancy

Several companies share one database. Thirteen of the fourteen models carry an
`orgId`; `Session` is the exception, because a session is how the application
*finds out* which organisation a request belongs to and cannot be filtered by
the answer it is being asked for.

### Where the boundary is enforced

`src/server/scope.ts`. Every list and every detail lookup already went through
one of ten `where` builders, and each of those is now wrapped:

```ts
function inOrg<T extends object>(user: SessionUser, clause: T) {
  return { ...clause, orgId: user.orgId };
}
```

Applied at the boundary rather than inside each switch, so a builder written
next year cannot forget - forgetting is not something an individual builder is
able to do. The spread order matters too: `{ ...clause, orgId }` and not the
reverse, so a clause carrying its own `orgId` cannot overwrite the session's.

### The unique keys

This is the part that bites, and it bites silently. `Lead.phoneKey`,
`Lead.emailKey`, `(source, externalId)`, `Order.orderNo`, `Quotation.quoteNo`
and `User.email` were all globally unique. Left that way:

- one company capturing a lead would **permanently stop every other company**
  from ever capturing the same person, and nobody would see an error - the
  customer would simply never appear;
- no two companies could both have an `ORD-2026-0001`.

All six are now composite on `orgId`. Deduplication still works *inside* an
organisation, and there are tests for both halves.

### One email, two companies

`User.email` is unique within an organisation, not across the platform. Someone
who owns a manufacturing company and a trading company is an ordinary thing in
this market, and they get two accounts with their own role and their own
password.

Sign-in takes an optional workspace. Leave it blank and the email finds its
workspace on its own; it is only needed when one address signs into two, and
the login refuses to guess between them.

### Signing up, and the letterhead

A company signs itself up at `/signup` - five fields, and none of them is an
address or a bank account. Everything the letterhead needs is asked for on
Settings instead, once they are inside and can see what it is for; eleven
fields before seeing the product is how a signup form gets abandoned.

The letterhead used to be seven environment variables, which could only ever
describe one company. It now belongs to the organisation: name, address,
GSTIN, bank account and logo, read fresh every time a quotation is rendered.
A field left blank prints as blank, never as a placeholder that looks like a
value - Settings is where the nagging belongs, and it does nag.

The logo is stored as bytes, not as a link. A quotation goes out and is kept;
pointing at an image host means the day that host moves the file, every
document ever sent renders with a hole in it.

GSTIN, IFSC and account number are format-checked before saving. A wrong IFSC
does not fail loudly - it prints, the customer pays into nowhere, and somebody
finds out a week later.

### Whoever runs the software

`/admin`, behind a `PlatformAdmin` account created by `npm run platform-admin`.
There is no route that creates one, so it takes the database credentials -
which is the right bar for an identity that can reach every customer.

Deliberately **not** a role on `User`. The isolation everything else rests on
is that a user belongs to one organisation and no branch anywhere can turn
that filter off. A superadmin role would put the branch back, and every query
written afterwards would depend on nobody reaching it by accident. So it is a
separate identity with a separate session table, and it reaches customer data
by two explicit routes only:

- **The console** lists workspaces and can suspend one. Its query is called
  `listAllWorkspaces`, so crossing organisations is visible at the call site.
- **Opening a workspace** issues an *ordinary* session as that company's
  owner - same scope clauses, same permissions, an hour long. Support happens
  inside a tenant rather than through a hole in the boundary, so a bug in the
  CRM can never widen it.

Every visit puts a banner on every screen and a row in **that company's own
audit trail**, where the customer can read it. Nothing in `server/scope.ts`
knows any of this exists, which is the point.

A seeded account starts with `mustChangePassword`, and the console refuses to
do anything until it is changed: whatever password it was created with has by
then been in a shell history.

### Two backstops, and what each one actually covers

`scope.ts` is the control. These two exist because a control with no
independent check is a claim.

**Row-level security** (`20260901030000_row_level_security`) covers everything
that does not come through the application: a psql session, a BI tool, an
analytics job, a leaked read-only credential. Those connect as a restricted
role and cannot read past one organisation however the query is written - a
reader that asks explicitly for another organisation's rows gets none, and one
that forgets to say who it is gets nothing at all rather than everything.

It deliberately does **not** gate the application's own queries. RLS reads the
tenant from a connection-level setting, and on a shared pool that can only be
bound inside a transaction; wrapping every read in one would double the round
trips on an application tuned to reduce them. The app connects as the table
owner, and an owner bypasses RLS unless `FORCE ROW LEVEL SECURITY` is set.

The migration documents the restricted role an operator creates once.

**The tenant guard** (`src/lib/tenant-guard.ts`) is the other direction: it
catches the application forgetting its own filter. It is **off by default**,
and that is a finding rather than a compromise. Run against this codebase it
flags about a hundred and ten calls and nearly all are safe - a payment
aggregate filtered by an orderId whose scope was checked three lines above
looks identical to a genuinely unscoped one, and no static rule separates them.
A guard that blocked those would be switched off within a week.

What it is good for is an audit, read once:

```bash
TENANT_GUARD=warn npm test      # list every unscoped set operation
TENANT_GUARD=strict npm test    # stop at the first one
```

Doing exactly that is how the six cross-organisation holes in `server/users.ts`
were found - including a password reset that would have let one company take
over another company's owner account. There is a regression test for each.

### What is still global

IndiaMART and Meta credentials are process-wide environment variables, so they
can only serve one organisation - one CRM key fetches one seller's enquiries.
`INTEGRATIONS_ORG_SLUG` names the workspace they belong to. Returning nothing
when it is unset is deliberate: delivering one seller's enquiries into somebody
else's workspace is worse than delivering them nowhere and saying so.

Moving those credentials into the database per organisation is the next piece
of work; the cron then iterates organisations instead of reading one key.

---

## How the rules are enforced

### The grab is race safe

```ts
const result = await prisma.lead.updateMany({
  where: { id: leadId, ownerId: null },
  data: { ownerId: user.id, grabbedAt: new Date() },
});
if (result.count !== 1) { /* somebody else won */ }
```

The `ownerId: null` in the `WHERE` means Postgres picks the winner. Whichever
transaction commits first leaves a non-null owner and the second matches zero
rows. `count` is the only thing trusted; a read-then-write would race.

### Payment can never exceed the order

`recordPayment` runs inside a transaction that takes `SELECT ... FOR UPDATE`
on the order row before summing the existing payments. Without the lock, two
CREs recording the last two part-payments at the same instant would both read
the old sum and together overshoot.

Payment state (`UNPAID` / `PARTIAL` / `PAID`) is **derived** from those rows -
there is no column for it anywhere in the schema. Deleting a mistaken payment
walks the order back automatically, and reopens it if it was closed.

An order can only be closed when due is exactly zero.

### Deleting a user moves work, never destroys it

One transaction, in `src/server/users.ts`:

- **CRE deleted** - their orders and leads go to the salesman that CRE was
  assigned to. The order loses its CRE and returns to that salesman.
- **Salesman deleted** - the admin names another salesman first, and the
  leads, the orders *and* the CREs all move there together, so the CREs carry
  on serving the same orders under their new salesman.

Stage, status and payment history are carried across untouched. `stage` in
particular is deliberately **not** normalised: an order that was `WITH_CRE`
stays `WITH_CRE`, exactly as specified, and the order page flags it as
awaiting re-handover rather than quietly rewriting it.

Before committing, the transaction re-counts what is left pointing at the
deleted account. If anything remains it throws, which rolls the whole thing
back - refusing is better than orphaning. Every deletion writes an audit row
inside the same transaction, readable at the bottom of the Lead sources page.

### The guidebook cannot lie

`src/lib/permissions.ts` is the only place that says who may do what. Two
consumers read it:

- `requirePermission()` in every server action and data function,
- `permissionsForRole()` on each user's Guidebook page.

The "Not available to you" list is computed by negation from the same rows, so
it cannot drift. Data visibility works the same way: `DATA_SCOPES` is turned
into Prisma `where` clauses in `src/server/scope.ts` and printed in words on
the guidebook, so a role can never be shown a scope the queries do not apply.

### The tests

`npm test`, on Node's built-in runner. No Jest, no Vitest, no config file -
`node --test` plus the `tsx` loader that was already a dependency for the seed
script.

They cover the pure modules, which is where the invariants this app leans on
actually live:

| File | What it pins down |
|---|---|
| `money.test.ts` | Rupee parsing rejects a third decimal instead of rounding it; Indian 2-3-3 grouping; the BigInt boundary throws rather than losing precision |
| `quotation-math.test.ts` | The line amount rounds exactly once; GST is charged on goods **plus** freight; the formula parser cannot express anything but arithmetic |
| `dedupe.test.ts` | Seven spellings of one Indian mobile number collapse to one key; the junk lead sources send in the email field is rejected rather than collided |
| `order-state.test.ts` | Payment state is a fold over the payment rows, so deleting a payment walks a PAID order back to PARTIAL on its own |
| `permissions.test.ts` | Enforcement and the Guidebook agree for every role and every permission; no role is granted a scope the queries never apply |
| `dates.test.ts` | A month means a month in `APP_TIMEZONE`, so an order confirmed at 3am IST on the 1st lands in the right month and the right year |

It runs with `--conditions=react-server`, because the modules under test
import `server-only`; without it the suite would be testing a file the server
never loads.

### The integration tests

Three things this application promises are properties of Postgres, not of the
TypeScript, and a mock would only ever agree with whatever the code does
today:

| File | What it proves |
|---|---|
| `tenant-isolation.test.ts` | One company cannot see, open, grab or take payment on another's rows - checked against an ADMIN, whose scope is the widest any role has |
| `grab-race.test.ts` | Ten salesmen grabbing one lead at the same instant leaves exactly one owner, and one GRAB activity |
| `payment-lock.test.ts` | Concurrent payments can never sum past the order value - the `SELECT ... FOR UPDATE` really serialises them |
| `delete-user.test.ts` | Deleting a user moves leads, orders, quotations and CREs, preserves stage verbatim, and **rolls back rather than orphaning** - a refused deletion leaves no audit row either |

They need a real, throwaway Postgres, and they **skip cleanly** when one is not
named, so `npm test` works on a machine with no database:

```bash
docker run -d --name crm-test-pg   -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=crm_test   -p 55432:5432 postgres:16-alpine

export TEST_DATABASE_URL="postgresql://test:test@localhost:55432/crm_test"
DIRECT_DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
npm test
```

`TEST_DATABASE_URL` is deliberately a separate variable from `DATABASE_URL`:
these tests `TRUNCATE` every table, so pointing them at a development database
by forgetting one variable would destroy real data. You have to name the
throwaway one on purpose.

The test script passes `--test-concurrency=1`. Node runs test *files* in
parallel by default, and these share one database, so one file's truncate was
deleting another file's fixtures mid-test.

### Getting back in

Only the owner may reset an owner's password, there is no email-based reset
yet, and `npm run seed` is idempotent - it does nothing once an owner exists.
So an owner who forgets their password cannot be helped by anybody. That is
what `npm run reset-password` is for:

```bash
npm run reset-password -- owner@example.com          # generates and prints one
npm run reset-password -- owner@example.com "chosen" # or use your own
```

It grants no new authority - it needs `DIRECT_DATABASE_URL` and `AUTH_SECRET`,
and whoever holds those could already write the row by hand. What it adds is
doing it correctly: the same scrypt parameters the app verifies against, every
session torn down in the same transaction, and an audit row written with a
null actor, so a password changed from a shell is as visible afterwards as one
changed from the People page.

---

## Roles

| Role | Can |
|---|---|
| **owner** | Everything, plus creating admins. Created by the seed script. Cannot be deleted |
| **admin** | Creates and deletes salesman and CRE accounts, assigns each CRE to a salesman, sees every number |
| **salesman** | Grabs leads from the pool, works them, confirms orders, hands each to one of *their* CREs |
| **cre** | Records payments on the orders handed to them, closes them once nothing is due. Never sees the pool |

---

## Money

Indian Rupees, stored as integer paise in a `BigInt` column - a large order in
paise overflows a 32-bit integer at about 21 lakh rupees. `BigInt` does not
cross the React Server Component boundary, so every read converts to a plain
number the moment it leaves the data layer (`src/lib/money.ts`). There is no
floating point in the money path: rupees typed by a human are parsed to paise
by string, and anything with more than two decimal places is rejected rather
than silently rounded.

Display uses Indian 2-3-3 grouping (`12,34,567`) done by hand, so the server
and the client always agree regardless of the ICU data a runtime happens to
ship.

---

## Layout

```
prisma/
  schema.prisma          data model
  migrations/            prisma migrate deploy runs these
  seed.ts                creates the owner
src/
  lib/
    permissions.ts       THE permission table - enforcement and guidebook
    db.ts                lazy PrismaClient over the pg driver adapter
    env.ts               lazily validated environment, nothing hardcoded
    money.ts             integer paise, INR formatting
    password.ts          scrypt from node:crypto, no native deps
    session.ts           database-backed sessions, sha256 of an opaque token
    dates.ts             month ranges in APP_TIMEZONE
    dedupe.ts            phone and email normalisation
  server/
    scope.ts             DATA_SCOPES -> Prisma where clauses
    leads.ts             pool, grab, manual entry
    orders.ts            confirm, handover, payments, close
    users.ts             create, and the delete-and-transfer transaction
    overview.ts          month-scoped aggregates
    ingest/              indiamart.ts, meta.ts, common.ts
  actions/               server actions, one file per area
  app/                   routes
  components/            shared UI
tests/
  env-setup.mjs          a minimal valid environment, loaded before the suite
  *.test.ts              one file per module under test
```
