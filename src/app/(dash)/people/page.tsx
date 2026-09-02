import type { Metadata } from "next";
import Link from "next/link";
import { requirePageAccess } from "@/lib/auth";
import { can, creatableRoles, ROLE_LABEL } from "@/lib/permissions";
import { formatDate, relativeTime } from "@/lib/dates";
import { suggestPassword } from "@/lib/password";
import { listSalesmen, listUsers } from "@/server/users";
import {
  assignCreAction,
  createUserAction,
  resetPasswordAction,
  setUserActiveAction,
} from "@/actions/users";
import { ActionButton, ActionForm } from "@/components/form";
import { Field, FieldRow, Input, Select } from "@/components/fields";
import { PasswordInput } from "@/components/password-input";
import {
  Badge,
  Card,
  CardHeader,
  LinkButton,
  Notice,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";

export const metadata: Metadata = { title: "People" };

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ deleted?: string }>;
}) {
  const user = await requirePageAccess("user.view", "/people");
  const { deleted } = await searchParams;

  const [people, salesmen] = await Promise.all([
    listUsers(user),
    listSalesmen(user.orgId),
  ]);
  const roles = creatableRoles(user.role);
  const startingPassword = suggestPassword();

  return (
    <>
      <PageHeader
        title="People"
        subtitle="Every account is created here. Nobody can sign themselves up."
      />

      {deleted ? (
        <div className="mb-4">
          <Notice tone="ok" title="Account deleted">
            {deleted}
          </Notice>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2" padded={false}>
          <div className="p-5 pb-0">
            <CardHeader
              title="The team"
              hint="A CRE always reports to exactly one salesman."
            />
          </div>
          <div className="px-5 pb-5">
            <Table>
              <thead>
                <tr>
                  <Th>Person</Th>
                  <Th>Role</Th>
                  <Th>Reports to</Th>
                  <Th align="right">Holding</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {people.map((person) => (
                  <tr key={person.id} className={person.isActive ? "" : "opacity-55"}>
                    <Td>
                      <div className="font-medium">{person.name}</div>
                      <div className="text-xs text-[var(--text-faint)]">
                        {person.email}
                      </div>
                      <div className="text-xs text-[var(--text-faint)]">
                        {person.lastLoginAt
                          ? `last in ${relativeTime(person.lastLoginAt)}`
                          : `never signed in - added ${formatDate(person.createdAt)}`}
                      </div>
                    </Td>
                    <Td>
                      <Badge
                        tone={
                          person.role === "OWNER"
                            ? "accent"
                            : person.role === "ADMIN"
                              ? "warn"
                              : "neutral"
                        }
                      >
                        {ROLE_LABEL[person.role]}
                      </Badge>
                      {!person.isActive ? (
                        <div className="mt-1">
                          <Badge tone="danger">Deactivated</Badge>
                        </div>
                      ) : null}
                    </Td>
                    <Td className="text-sm">
                      {person.role === "CRE" ? (
                        can(user.role, "user.assign.cre") && salesmen.length > 0 ? (
                          /* Checkboxes, not a select: a CRE can work for
                             several salesmen, and every one of them ticked
                             here becomes an option in their own sidebar
                             switcher. */
                          <ActionForm
                            action={assignCreAction}
                            submitLabel="Save"
                            submitVariant="ghost"
                            pendingLabel="Saving..."
                            hidden={{ creId: person.id }}
                            className="space-y-1"
                          >
                            <fieldset className="flex flex-col gap-0.5">
                              <legend className="sr-only">
                                Salesmen {person.name} works for
                              </legend>
                              {salesmen.map((salesman) => (
                                <label
                                  key={salesman.id}
                                  className="flex items-center gap-1.5 text-sm"
                                >
                                  <input
                                    type="checkbox"
                                    name="salesmanIds"
                                    value={salesman.id}
                                    defaultChecked={person.salesmen.some(
                                      (entry) => entry.id === salesman.id,
                                    )}
                                    className="h-3.5 w-3.5 accent-[var(--accent)]"
                                  />
                                  {salesman.name}
                                </label>
                              ))}
                            </fieldset>
                          </ActionForm>
                        ) : person.salesmen.length > 0 ? (
                          person.salesmen.map((entry) => entry.name).join(", ")
                        ) : (
                          "unassigned"
                        )
                      ) : person.role === "SALESMAN" ? (
                        <span className="text-[var(--text-faint)]">
                          {person.counts.cres} CRE
                          {person.counts.cres === 1 ? "" : "s"}
                        </span>
                      ) : (
                        <span className="text-[var(--text-faint)]">-</span>
                      )}
                    </Td>
                    <Td align="right" numeric className="text-sm">
                      <div>{person.counts.leads} leads</div>
                      <div className="text-[var(--text-faint)]">
                        {person.role === "CRE"
                          ? `${person.counts.creOrders} orders`
                          : `${person.counts.orders} orders`}
                      </div>
                    </Td>
                    <Td align="right">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {can(user.role, "user.update") ? (
                          <LinkButton
                            href={`/people/${person.id}/edit`}
                            variant="ghost"
                          >
                            Edit
                          </LinkButton>
                        ) : null}
                        {person.role !== "OWNER" && person.id !== user.id ? (
                          <>
                            <ActionButton
                              action={setUserActiveAction}
                              variant="ghost"
                              hidden={{
                                targetId: person.id,
                                isActive: person.isActive ? "false" : "true",
                              }}
                            >
                              {person.isActive ? "Deactivate" : "Reactivate"}
                            </ActionButton>
                            <LinkButton
                              href={`/people/${person.id}/delete`}
                              variant="danger"
                            >
                              Delete
                            </LinkButton>
                          </>
                        ) : (
                          <span className="text-xs text-[var(--text-faint)]">
                            {person.id === user.id ? "you" : "protected"}
                          </span>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>

        <div className="space-y-4">
          {roles.length > 0 ? (
            <Card>
              <CardHeader
                title="Create an account"
                hint="You set the password. Hand it over, and they can change it from their account page."
              />
              <ActionForm
                action={createUserAction}
                submitLabel="Create account"
                pendingLabel="Creating..."
                resetOnSuccess
              >
                <Field label="Name" required>
                  <Input name="name" required maxLength={120} />
                </Field>
                <Field label="Email" required>
                  <Input name="email" type="email" required maxLength={254} />
                </Field>
                <FieldRow>
                  <Field label="Role" required>
                    <Select name="role" defaultValue={roles[0]}>
                      {roles.map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABEL[role]}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Phone">
                    <Input name="phone" type="tel" maxLength={40} />
                  </Field>
                </FieldRow>
                <Field
                  label="Works for"
                  hint="Required when the role is CRE, ignored otherwise. Tick more than one and they can switch between them from their sidebar."
                >
                  <fieldset className="flex flex-col gap-1">
                    <legend className="sr-only">
                      Salesmen this CRE works for
                    </legend>
                    {salesmen.length === 0 ? (
                      <span className="text-sm text-[var(--text-faint)]">
                        No active salesmen yet. Create one before adding a CRE.
                      </span>
                    ) : (
                      salesmen.map((salesman) => (
                        <label
                          key={salesman.id}
                          className="flex items-center gap-2 text-base"
                        >
                          <input
                            type="checkbox"
                            name="salesmanIds"
                            value={salesman.id}
                            className="h-3.5 w-3.5"
                          />
                          {salesman.name}
                        </label>
                      ))
                    )}
                  </fieldset>
                </Field>
                <Field
                  label="Starting password"
                  required
                  hint="Pre-filled with a suggestion. At least 8 characters."
                >
                  <PasswordInput
                    name="password"
                    defaultValue={startingPassword}
                    autoComplete="new-password"
                    required
                    minLength={8}
                    // Shown: this is the password being handed to somebody.
                    initiallyVisible
                  />
                </Field>
              </ActionForm>
            </Card>
          ) : null}

          {can(user.role, "user.password.reset") ? (
            <Card>
              <CardHeader
                title="Reset a password"
                hint="Signs that person out of every device immediately."
              />
              <ActionForm
                action={resetPasswordAction}
                submitLabel="Reset password"
                submitVariant="secondary"
                pendingLabel="Resetting..."
                resetOnSuccess
              >
                <Field label="Account" required>
                  <Select name="targetId" defaultValue="">
                    <option value="">Choose...</option>
                    {people.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name} ({ROLE_LABEL[person.role]})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="New password" required>
                  {/* Was a plain text input: an admin resetting somebody's
                      password had it legible on screen to whoever was
                      standing behind them. */}
                  <PasswordInput
                    name="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                  />
                </Field>
              </ActionForm>
            </Card>
          ) : null}

          {can(user.role, "audit.view") ? (
            <p className="text-sm text-[var(--text-faint)]">
              Deletions and transfers are written to the audit trail, which you
              can read at the bottom of the{" "}
              <Link href="/sources" className="text-[var(--accent-text)] hover:underline">
                Lead sources
              </Link>{" "}
              page.
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
