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
| `npm test` | The unit suite, on Node's built-in runner |

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

### The Google mirror

Quotations are written to Postgres **first** and pushed to the Sheet and Drive
afterwards, in `next/server`'s `after()` so the button does not wait on a PDF
render and two Google round trips.

That ordering is the whole design: Google being slow, rate limited or down can
never lose a quotation or block a CRE. A failed push is recorded on the
quotation with the reason, shown on the Quotations page, and retried - by hand
from Lead sources, or by a cron on `POST /api/cron/mirror`.

Re-mirroring overwrites the same row and the same Drive file rather than
appending a second, so the sheet holds one live line per quotation.

### Client import

`Clientdata` is pulled into Company and Contact records from the Lead sources
page. Idempotent: re-running fills gaps and never overwrites something a person
has since typed.

Matching a sheet's sales-executive spelling to a CRM account is done by exact
normalised name or by an explicit `User.sheetAlias`, never by fuzzy similarity.
Anything unmatched is imported unassigned and reported by name, because
silently attaching a client to the wrong salesman is worse than leaving it
visibly unassigned.

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

Two things the suite deliberately does not do. It never opens a database
connection: anything that would is integration territory and belongs with a
real Postgres, not with a mock that agrees with whatever the code does today.
And it runs with `--conditions=react-server`, because the modules under test
import `server-only`; without it the suite would be testing a file the server
never loads.

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
