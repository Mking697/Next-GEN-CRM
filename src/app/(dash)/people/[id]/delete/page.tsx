import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageAccess } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/permissions";
import { previewDeletion } from "@/server/users";
import { deleteUserAction } from "@/actions/users";
import { ActionForm } from "@/components/form";
import { Field, Select } from "@/components/fields";
import {
  Card,
  CardHeader,
  LinkButton,
  Notice,
  PageHeader,
  Table,
  Td,
  Th,
} from "@/components/ui";

export const metadata: Metadata = { title: "Delete account" };

/**
 * The confirmation screen for a delete.
 *
 * Everything shown here is worked out by previewDeletion() against the real
 * rows, so the sentence the admin reads is the sentence the transaction will
 * carry out. Nothing on this page is an estimate.
 */
export default async function DeleteUserPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requirePageAccess("user.delete", `/people/${id}/delete`);

  const preview = await previewDeletion(user, id).catch(() => null);
  if (!preview) notFound();

  const totalMoving =
    preview.moving.leads +
    preview.moving.orders +
    preview.moving.creOrders +
    preview.moving.cres;

  return (
    <>
      <PageHeader
        title={`Delete ${preview.name}`}
        subtitle={`${ROLE_LABEL[preview.role]} account. Nothing this account holds is destroyed; it all moves to somebody else in one transaction.`}
        action={<LinkButton href="/people">Cancel</LinkButton>}
      />

      {preview.blockedReason ? (
        <Notice tone="danger" title="This account cannot be deleted">
          {preview.blockedReason}
        </Notice>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader
              title="What moves"
              hint="Stage, status and payment history are carried across untouched."
            />
            <Table>
              <thead>
                <tr>
                  <Th>What</Th>
                  <Th align="right">How many</Th>
                  <Th>Where it goes</Th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <Td>Leads owned</Td>
                  <Td align="right" numeric>
                    {preview.moving.leads}
                  </Td>
                  <Td className="text-[var(--text-muted)]">
                    Owner changes. Status and follow-up date stay as they are.
                  </Td>
                </tr>
                {preview.role === "CRE" ? (
                  <tr>
                    <Td>Orders being collected</Td>
                    <Td align="right" numeric>
                      {preview.moving.creOrders}
                    </Td>
                    <Td className="text-[var(--text-muted)]">
                      Return to the salesman. Stage stays exactly as it is, so
                      an order that was With CRE still reads With CRE and is
                      flagged for re-handover.
                    </Td>
                  </tr>
                ) : (
                  <>
                    <tr>
                      <Td>Orders confirmed</Td>
                      <Td align="right" numeric>
                        {preview.moving.orders}
                      </Td>
                      <Td className="text-[var(--text-muted)]">
                        Salesman changes. Whoever is collecting keeps
                        collecting.
                      </Td>
                    </tr>
                    <tr>
                      <Td>CREs reporting in</Td>
                      <Td align="right" numeric>
                        {preview.moving.cres}
                      </Td>
                      <Td className="text-[var(--text-muted)]">
                        Move across too, so they carry on serving the same
                        orders under their new salesman.
                      </Td>
                    </tr>
                  </>
                )}
                <tr>
                  <Td>Payments</Td>
                  <Td align="right" numeric>
                    0
                  </Td>
                  <Td className="text-[var(--text-muted)]">
                    Never touched. Every payment row and its date, amount and
                    reference stay exactly where they are.
                  </Td>
                </tr>
              </tbody>
            </Table>
          </Card>

          <Card>
            <CardHeader title="Confirm" />
            <ActionForm
              action={deleteUserAction}
              submitLabel={`Delete ${preview.name}`}
              submitVariant="danger"
              pendingLabel="Deleting..."
              hidden={{ targetId: preview.id }}
            >
              {preview.role === "CRE" && preview.destination ? (
                <Notice tone="ok" title="Destination is fixed">
                  Everything goes to {preview.destination.name}, the salesman
                  this CRE was assigned to.
                </Notice>
              ) : totalMoving > 0 ? (
                <Field
                  label="Move everything to"
                  required
                  hint="This salesman receives the leads, the orders and the CREs."
                >
                  <Select name="transferToId" defaultValue="" required>
                    <option value="">Choose a salesman...</option>
                    {preview.candidates.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <Notice>
                  This account holds no leads, orders or CREs. There is nothing
                  to move.
                </Notice>
              )}

              <p className="text-sm leading-relaxed text-[var(--text-muted)]">
                The move and the delete happen in a single database
                transaction. If any part of it fails, nothing is deleted and
                nothing is moved.
              </p>
            </ActionForm>
          </Card>
        </div>
      )}
    </>
  );
}
