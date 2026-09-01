import { requireUser } from "@/lib/auth";
import { can, ROLE_LABEL } from "@/lib/permissions";
import { countPool } from "@/server/leads";
import { Nav, type NavItem } from "@/components/nav";

/**
 * The signed-in shell.
 *
 * Which links appear is decided here, from the same permission table the
 * server actions enforce with. A CRE is not shown the pool because
 * `pool.view` is not granted to CRE, not because of a hardcoded role check
 * in the navigation.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  const showPool = can(user.role, "pool.view");
  const poolCount = showPool ? await countPool(user) : 0;

  const items: NavItem[] = [
    { href: "/overview", label: "Overview" },
    ...(showPool ? [{ href: "/pool", label: "Lead pool", badge: poolCount }] : []),
    { href: "/leads", label: user.role === "CRE" ? "Leads for me" : "My leads" },
    { href: "/quotations", label: "Quotations" },
    { href: "/orders", label: "Orders" },
    ...(can(user.role, "user.view") ? [{ href: "/people", label: "People" }] : []),
    ...(can(user.role, "integration.view")
      ? [{ href: "/sources", label: "Lead sources" }]
      : []),
    ...(can(user.role, "workspace.view")
      ? [{ href: "/settings", label: "Your company" }]
      : []),
    { href: "/guidebook", label: "Guidebook" },
  ];

  return (
    <div className="min-h-dvh lg:pl-60">
      {/* Somebody who runs this software is inside this company's workspace.
          Said on every screen, not tucked into a settings page, and written
          into this workspace's own audit trail as well - the customer is
          entitled to see that it happened. */}
      {user.impersonatedBy ? (
        <div className="sticky top-0 z-30 bg-[var(--warn)] px-4 py-1.5 text-center text-xs font-medium text-black">
          Support session &mdash; {user.impersonatedBy.name} (
          {user.impersonatedBy.email}) is signed in to {user.orgName} as{" "}
          {user.name}. Everything done here is recorded.
        </div>
      ) : null}
      <Nav
        items={items}
        user={{
          name: user.name,
          email: user.email,
          role: ROLE_LABEL[user.role],
        }}
        // Only worth showing when there is actually a choice to make. One
        // salesman needs no switcher, and everybody else has none at all.
        acting={
          user.salesmen.length > 1
            ? {
                options: user.salesmen,
                activeId: user.activeSalesmanId,
              }
            : null
        }
      />
      <main className="mx-auto max-w-6xl px-5 pt-14 pb-16 lg:px-8 lg:pt-8">
        {children}
      </main>
    </div>
  );
}
