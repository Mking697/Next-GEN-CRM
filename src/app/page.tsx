import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AuthPanel } from "@/components/auth-panel";

export const metadata: Metadata = {
  title: "Sales CRM",
  description:
    "Enquiries from IndiaMART, Meta and walk-ins become quotations, orders and collected payments - without anybody retyping a number.",
  // The one page in the application that is meant to be found.
  robots: { index: true, follow: true },
};

/**
 * The first screen anybody sees.
 *
 * Two jobs at once: tell somebody who has never heard of this what it does,
 * and get somebody who uses it every day into it in two fields. So the page
 * is split - the product on the left, the way in on the right - rather than a
 * marketing page with a sign-in link buried in a corner.
 *
 * On a phone that split becomes a stack, and the sign-in goes FIRST. The
 * person on a phone at 9am is a salesman who already works here; the person
 * reading the pitch has a laptop.
 */
export default async function LandingPage() {
  if (await currentUser()) redirect("/overview");

  return (
    <main className="flex min-h-dvh flex-col lg:grid lg:grid-cols-[1.05fr_minmax(26rem,0.95fr)]">
      {/* ================= the product ================= */}
      <section className="relative order-2 flex flex-col justify-center overflow-hidden bg-[var(--panel)] px-6 py-14 text-[var(--panel-text)] sm:px-10 lg:order-1 lg:px-14 lg:py-16">
        {/* A soft wash from one corner, so a large flat panel is not
            actually flat. Pointer-events off - it is decoration and must
            never sit between a finger and a control. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 hidden lg:block"
          style={{
            background:
              "radial-gradient(60rem 40rem at 8% 0%, var(--panel) 0%, var(--panel-2) 68%)",
          }}
        />

        <div className="relative mx-auto w-full max-w-xl stagger">
          <div style={{ "--i": 0 } as React.CSSProperties}>
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-md font-semibold text-white">
                C
              </div>
              <span className="text-md font-semibold tracking-tight">Sales CRM</span>
            </div>
          </div>

          <h1
            className="mt-8 font-semibold tracking-tight text-balance"
            style={{
              "--i": 1,
              fontSize: "var(--text-display)",
              lineHeight: "var(--text-display--line-height)",
              letterSpacing: "-0.03em",
            } as React.CSSProperties}
          >
            Enquiry to paid, without retyping a number.
          </h1>

          <p
            className="mt-5 max-w-lg text-md leading-relaxed text-[var(--panel-muted)]"
            style={{ "--i": 2 } as React.CSSProperties}
          >
            Leads arrive from IndiaMART, Meta and walk-ins into one shared pool.
            A salesman takes one, a CRE quotes it, and the accepted quotation
            becomes the order they collect against. The order value comes from
            the quotation, so the two documents cannot disagree.
          </p>

          {/* -- the pipeline -------------------------------------------- */}
          <ol
            className="mt-10 space-y-0"
            style={{ "--i": 3 } as React.CSSProperties}
          >
            {STAGES.map((stage, index) => (
              <li key={stage.title} className="relative flex gap-4 pb-7 last:pb-0">
                {/* The line joining one stage to the next; not drawn after
                    the last one. */}
                {index < STAGES.length - 1 ? (
                  <span
                    aria-hidden
                    className="absolute top-8 bottom-0 left-[0.9375rem] w-px bg-[var(--panel-line)]"
                  />
                ) : null}
                <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-[var(--panel-line)] bg-[var(--panel-2)] text-[var(--panel-accent)]">
                  {stage.icon}
                </span>
                <div className="pt-1">
                  <div className="text-base font-semibold">{stage.title}</div>
                  <div className="mt-0.5 text-base leading-relaxed text-[var(--panel-muted)]">
                    {stage.body}
                  </div>
                </div>
              </li>
            ))}
          </ol>

          {/* -- what is actually different about it --------------------- */}
          <dl
            className="mt-11 grid gap-x-8 gap-y-6 border-t border-[var(--panel-line)] pt-9 sm:grid-cols-2"
            style={{ "--i": 4 } as React.CSSProperties}
          >
            {POINTS.map((point) => (
              <div key={point.title}>
                <dt className="text-base font-semibold">{point.title}</dt>
                <dd className="mt-1 text-base leading-relaxed text-[var(--panel-muted)]">
                  {point.body}
                </dd>
              </div>
            ))}
          </dl>

          <p
            className="mt-10 text-sm leading-relaxed text-[var(--panel-muted)]"
            style={{ "--i": 5 } as React.CSSProperties}
          >
            Every company gets its own workspace. Your leads, your customers and
            your numbers are visible to nobody else.
          </p>
        </div>
      </section>

      {/* ================= the way in =================
          order-1 below lg, which needs the flex column on <main> to take
          effect at all - `order` does nothing on a block container. The
          person on a phone at 9am already works here and wants the two
          fields, not the pitch. */}
      <section className="order-1 flex items-center justify-center bg-[var(--bg)] px-6 py-12 sm:px-10 lg:order-2 lg:py-16">
        <AuthPanel />
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

/**
 * Icons are drawn here rather than pulled from a library.
 *
 * Five glyphs at one stroke weight is not worth a dependency, and inlining
 * them means they take the panel's colour from currentColor and need no
 * loading state.
 */
const iconProps = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

const STAGES = [
  {
    title: "The lead pool",
    body: "IndiaMART, Meta Lead Ads and walk-ins land in one place, deduplicated. Whoever grabs a lead first owns it - decided by the database, so two people cannot both get it.",
    icon: (
      <svg {...iconProps}>
        <path d="M3 7h18M3 12h18M3 17h10" />
      </svg>
    ),
  },
  {
    title: "The quotation",
    body: "A spreadsheet-style grid: paste from Excel, and a calculator that keeps the working, not just the answer. Sends as a PDF on your own letterhead.",
    icon: (
      <svg {...iconProps}>
        <path d="M4 4h16v16H4z" />
        <path d="M4 9h16M9 9v11" />
      </svg>
    ),
  },
  {
    title: "The order",
    body: "Placed from the accepted quotation, for exactly its amount. Handed to the CRE who will collect against it.",
    icon: (
      <svg {...iconProps}>
        <path d="M20 7 9 18l-5-5" />
      </svg>
    ),
  },
  {
    title: "The money",
    body: "Part payments as they come. An order closes only when nothing is due, and deleting a wrong entry walks it back on its own.",
    icon: (
      <svg {...iconProps}>
        <path d="M3 6h18v12H3z" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    ),
  },
];

const POINTS = [
  {
    title: "IndiaMART, built in",
    body: "Enquiries arrive on their own, every five minutes. No global CRM does this.",
  },
  {
    title: "GST that is right",
    body: "Charged on goods plus freight, with the base printed next to the rate so it is never a hidden assumption.",
  },
  {
    title: "Money in whole paise",
    body: "No floating point anywhere. A third decimal is refused rather than quietly rounded.",
  },
  {
    title: "Everyone sees their own",
    body: "A salesman, a CRE and an owner each get a different view, and a guidebook that says exactly why.",
  },
];
