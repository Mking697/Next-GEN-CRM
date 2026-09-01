import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import {
  DATA_SCOPES,
  permissionsForRole,
  restrictionsForRole,
  ROLE_LABEL,
  ROLE_TAGLINE,
  SCOPE_KEYS,
  SCOPE_LABELS,
  scopeWords,
} from "@/lib/permissions";
import type { Role } from "@/generated/prisma/enums";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Guidebook" };

/**
 * The guidebook.
 *
 * Nothing on this page is written for the page. Every entry is read out of
 * lib/permissions, which is the same table requirePermission() enforces
 * against on every action. So the guidebook cannot describe a permission the
 * user does not have, and it cannot omit one they do: both lists are computed
 * from the same rows, one by filtering for granted and one by filtering for
 * not granted.
 */
export default async function GuidebookPage() {
  const user = await requireUser("/guidebook");

  const sections = permissionsForRole(user.role);
  const restrictions = restrictionsForRole(user.role);

  return (
    <>
      <PageHeader
        title="Your guidebook"
        subtitle={`What a ${ROLE_LABEL[user.role]} account can do in this CRM, read straight out of the permission rules the app enforces.`}
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-start gap-3">
          <Badge tone="accent" className="mt-0.5">
            {ROLE_LABEL[user.role]}
          </Badge>
          <p className="min-w-0 flex-1 text-base text-[var(--text-muted)]">
            {ROLE_TAGLINE[user.role]}
          </p>
        </div>
      </Card>

      <Card className="mb-4">
        <CardHeader
          title="How much you can see"
          hint="These are the exact filters the database queries run with."
        />
        {/* Driven off SCOPE_KEYS, not a hand-written list. The previous
            version named five of them, so `quotations` was enforced by
            quotationsWhere() and shown to nobody. */}
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {SCOPE_KEYS.map((key) => (
            <ScopeLine key={key} label={SCOPE_LABELS[key]} scopeKey={key} role={user.role} />
          ))}
        </div>
      </Card>

      <div className="space-y-4">
        {sections.map((section) => (
          <Card key={section.group}>
            <CardHeader title={section.title} />
            <ul className="space-y-3.5">
              {section.items.map((item) => (
                <li key={item.id} className="flex gap-2.5">
                  <span
                    aria-hidden
                    className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ok)]"
                  />
                  <div className="min-w-0">
                    <p className="text-base font-medium">{item.title}</p>
                    <p className="mt-0.5 text-base leading-relaxed text-[var(--text-muted)]">
                      {item.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>

      {restrictions.length > 0 ? (
        <Card className="mt-4">
          <CardHeader
            title="Not available to you"
            hint="Worked out by negation from the same table, so this list can never drift out of date."
          />
          <ul className="grid gap-2 sm:grid-cols-2">
            {restrictions.map((item) => (
              <li key={item.id} className="flex gap-2.5">
                <span
                  aria-hidden
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--border-strong)]"
                />
                <span className="text-base text-[var(--text-faint)]">
                  {item.title}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <p className="mt-5 text-sm leading-relaxed text-[var(--text-faint)]">
        If something on this page does not match what the app lets you do, the
        app is wrong, not this page. Both read{" "}
        <span className="font-mono">src/lib/permissions.ts</span>.
      </p>
    </>
  );
}

function ScopeLine({
  label,
  scopeKey,
  role,
}: {
  label: string;
  scopeKey: (typeof SCOPE_KEYS)[number];
  role: Role;
}) {
  const scope = DATA_SCOPES[role][scopeKey];
  const tone =
    scope === "ALL"
      ? "accent"
      : scope === "NONE"
        ? "neutral"
        : ("ok" as const);

  return (
    <div className="rounded-lg border bg-[var(--bg-sunken)] px-3 py-2">
      <div className="text-sm font-medium">{label}</div>
      <div className="mt-1">
        <Badge tone={tone}>{scopeWords(role, scopeKey)}</Badge>
      </div>
    </div>
  );
}
