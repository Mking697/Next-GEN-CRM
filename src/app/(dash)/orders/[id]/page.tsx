import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { formatDate, formatDateTime, toDateInputValue } from "@/lib/dates";
import { formatPaise, formatRupees } from "@/lib/money";
import { getOrder } from "@/server/orders";
import { PAYMENT_MODE_LABEL } from "@/server/order-state";
import {
  closeOrderAction,
  deleteOrderAction,
  deletePaymentAction,
  handOverAction,
  recordPaymentAction,
  reopenOrderAction,
  updateOrderAction,
} from "@/actions/orders";
import { ActionButton, ActionForm } from "@/components/form";
import {
  Field,
  FieldRow,
  Input,
  RupeeInput,
  Select,
  Textarea,
} from "@/components/fields";
import { PaymentBadge, StageBadge } from "@/components/badges";
import {
  Card,
  CardHeader,
  DefinitionRow,
  LinkButton,
  Meter,
  Notice,
  PageHeader,
  StatTile,
  Table,
  Td,
  Th,
} from "@/components/ui";

export const metadata: Metadata = { title: "Order" };

export default async function OrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser(`/orders/${id}`);

  const order = await getOrder(user, id);
  if (!order) notFound();

  const canHandOver =
    can(user.role, "order.handover") && order.stage !== "CLOSED";
  const canPay = can(user.role, "payment.record") && order.stage !== "CLOSED";
  const canCloseIt = can(user.role, "order.close") && order.canClose;
  const canEdit = can(user.role, "order.update");

  return (
    <>
      <PageHeader
        title={order.orderNo}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{order.companyName}</span>
            <StageBadge stage={order.stage} hasCre={Boolean(order.creId)} />
            <PaymentBadge state={order.paymentState} />
          </span>
        }
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/orders">Back to orders</LinkButton>
            {order.leadId ? (
              <LinkButton href={`/leads/${order.leadId}`}>Open the lead</LinkButton>
            ) : null}
          </div>
        }
      />

      {order.stage === "WITH_CRE" && !order.creId ? (
        <div className="mb-4">
          <Notice tone="warn" title="This order lost its CRE">
            The CRE who was holding it was deleted, so the order went back to{" "}
            {order.salesmanName}. Its stage, its payments and everything else
            were preserved exactly as they were. Hand it to another CRE to
            carry on collecting.
          </Notice>
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Order value" value={formatRupees(order.amountPaise)} />
        <StatTile
          label="Received"
          value={formatRupees(order.receivedPaise)}
          tone="ok"
          hint={`${order.percentReceived}% of the order`}
        />
        <StatTile
          label="Due"
          value={formatRupees(order.duePaise)}
          tone={order.duePaise > 0 ? "warn" : "ok"}
          hint={order.duePaise === 0 ? "Nothing outstanding" : undefined}
        />
        <StatTile
          label="Payments"
          value={order.payments.length}
          hint="Part payments allowed"
        />
      </div>

      <div className="mb-4">
        <Meter
          percent={order.percentReceived}
          tone={order.paymentState === "PAID" ? "ok" : "accent"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {canPay ? (
            <Card>
              <CardHeader
                title="Record a payment"
                hint={
                  order.duePaise > 0
                    ? `${formatPaise(order.duePaise)} is due. Anything larger than that is refused.`
                    : "This order is fully paid. Nothing more can be recorded against it."
                }
              />
              {order.duePaise > 0 ? (
                <ActionForm
                  action={recordPaymentAction}
                  submitLabel="Record payment"
                  pendingLabel="Recording..."
                  hidden={{ orderId: order.id }}
                  resetOnSuccess
                >
                  <FieldRow cols={3}>
                    <Field label="Amount" required>
                      <RupeeInput name="amount" required />
                    </Field>
                    <Field label="Mode" required>
                      <Select name="mode" defaultValue="BANK_TRANSFER">
                        {Object.entries(PAYMENT_MODE_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Received on">
                      <Input
                        name="receivedAt"
                        type="date"
                        defaultValue={toDateInputValue(new Date())}
                      />
                    </Field>
                  </FieldRow>
                  <FieldRow>
                    <Field label="Reference" hint="UTR, cheque number, UPI id.">
                      <Input name="reference" maxLength={120} />
                    </Field>
                    <Field label="Note">
                      <Input name="note" maxLength={500} />
                    </Field>
                  </FieldRow>
                </ActionForm>
              ) : (
                <Notice tone="ok">
                  Fully paid at {formatPaise(order.amountPaise)}.
                </Notice>
              )}
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Payment history"
              hint="Derived, never edited. The paid state above is the sum of these rows."
            />
            {order.payments.length === 0 ? (
              <p className="py-6 text-center text-base text-[var(--text-faint)]">
                Nothing received yet.
              </p>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Received</Th>
                    <Th>Mode</Th>
                    <Th>Reference</Th>
                    <Th>Recorded by</Th>
                    <Th align="right">Amount</Th>
                    {can(user.role, "payment.delete") ? <Th align="right" /> : null}
                  </tr>
                </thead>
                <tbody>
                  {order.payments.map((payment) => (
                    <tr key={payment.id}>
                      <Td>{formatDate(payment.receivedAt)}</Td>
                      <Td>{PAYMENT_MODE_LABEL[payment.mode]}</Td>
                      <Td className="font-mono text-xs">
                        {payment.reference ?? "-"}
                      </Td>
                      <Td className="text-sm text-[var(--text-muted)]">
                        {payment.recordedByName ?? "-"}
                      </Td>
                      <Td align="right" numeric className="font-medium">
                        {formatRupees(payment.amountPaise)}
                      </Td>
                      {can(user.role, "payment.delete") ? (
                        <Td align="right">
                          <ActionButton
                            action={deletePaymentAction}
                            variant="ghost"
                            pendingLabel="Removing..."
                            hidden={{ paymentId: payment.id, orderId: order.id }}
                            confirm="Remove this payment? The order will recompute, and a closed order will reopen if it is no longer fully paid."
                          >
                            Remove
                          </ActionButton>
                        </Td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

          {canEdit ? (
            <Card>
              <CardHeader
                title="Edit the order"
                hint="The value can never be set below what has already been received."
              />
              <ActionForm
                action={updateOrderAction}
                submitLabel="Save"
                submitVariant="secondary"
                pendingLabel="Saving..."
                hidden={{ orderId: order.id }}
              >
                <FieldRow>
                  <Field label="Order value">
                    <RupeeInput
                      name="amount"
                      defaultValue={(order.amountPaise / 100).toFixed(2)}
                    />
                  </Field>
                  <Field label="What was sold">
                    <Input name="title" defaultValue={order.title ?? ""} />
                  </Field>
                </FieldRow>
                <Field label="Notes">
                  <Textarea name="notes" defaultValue={order.notes ?? ""} rows={2} />
                </Field>
              </ActionForm>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Customer" />
            <dl>
              <DefinitionRow label="Company">{order.companyName}</DefinitionRow>
              <DefinitionRow label="Contact">
                {order.contactName ?? "-"}
              </DefinitionRow>
              <DefinitionRow label="Phone">
                {order.contactPhone ?? "-"}
              </DefinitionRow>
              <DefinitionRow label="Email">
                {order.contactEmail ?? "-"}
              </DefinitionRow>
              <DefinitionRow label="City">{order.city ?? "-"}</DefinitionRow>
              <DefinitionRow label="GSTIN">{order.gstin ?? "-"}</DefinitionRow>
            </dl>
          </Card>

          <Card>
            <CardHeader title="Who holds it" />
            <dl>
              <DefinitionRow label="Salesman">{order.salesmanName}</DefinitionRow>
              <DefinitionRow label="CRE">
                {order.creName ?? "not handed over"}
              </DefinitionRow>
              <DefinitionRow label="Confirmed">
                {formatDateTime(order.confirmedAt)}
              </DefinitionRow>
              <DefinitionRow label="Handed over">
                {order.handedOverAt ? formatDateTime(order.handedOverAt) : "-"}
              </DefinitionRow>
              <DefinitionRow label="Closed">
                {order.closedAt ? formatDateTime(order.closedAt) : "-"}
              </DefinitionRow>
            </dl>
          </Card>

          {canHandOver ? (
            <Card>
              <CardHeader
                title={order.creId ? "Move to another CRE" : "Hand to a CRE"}
                hint={`Only CREs assigned to ${order.salesmanName} can take this order.`}
              />
              {order.eligibleCres.length === 0 ? (
                <Notice tone="warn">
                  {order.salesmanName} has no CREs assigned yet. An admin needs
                  to assign one on the People page before this order can be
                  handed over.
                </Notice>
              ) : (
                <ActionForm
                  action={handOverAction}
                  submitLabel={order.creId ? "Move" : "Hand over"}
                  pendingLabel="Handing over..."
                  hidden={{ orderId: order.id }}
                >
                  <Field label="CRE" required>
                    <Select name="creId" defaultValue={order.creId ?? ""}>
                      <option value="">Choose a CRE...</option>
                      {order.eligibleCres.map((cre) => (
                        <option key={cre.id} value={cre.id}>
                          {cre.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </ActionForm>
              )}
            </Card>
          ) : null}

          {can(user.role, "order.close") ? (
            <Card>
              <CardHeader title="Close" />
              {order.stage === "CLOSED" ? (
                <div className="space-y-3">
                  <Notice tone="ok">
                    Closed on {formatDate(order.closedAt)}.
                  </Notice>
                  {canEdit ? (
                    <ActionButton
                      action={reopenOrderAction}
                      variant="secondary"
                      pendingLabel="Reopening..."
                      hidden={{ orderId: order.id }}
                    >
                      Reopen
                    </ActionButton>
                  ) : null}
                </div>
              ) : canCloseIt ? (
                <div className="space-y-3">
                  <p className="text-base text-[var(--text-muted)]">
                    Nothing is due. This order can be closed.
                  </p>
                  <ActionButton
                    action={closeOrderAction}
                    variant="primary"
                    pendingLabel="Closing..."
                    hidden={{ orderId: order.id }}
                  >
                    Close order
                  </ActionButton>
                </div>
              ) : (
                <Notice tone="warn">
                  {formatPaise(order.duePaise)} is still due. An order can only
                  be closed once nothing is outstanding.
                </Notice>
              )}
            </Card>
          ) : null}

          {order.notes ? (
            <Card>
              <CardHeader title="Notes" />
              <p className="text-base whitespace-pre-wrap text-[var(--text-muted)]">
                {order.notes}
              </p>
            </Card>
          ) : null}

          {can(user.role, "order.delete") ? (
            <Card>
              <CardHeader
                title="Delete this order"
                hint="For an order raised by mistake. The lead goes back to follow-up and the quotation returns to sent, so it can be corrected and placed again."
              />
              {order.receivedPaise > 0 ? (
                <div className="mb-3">
                  <Notice tone="danger" title="This order has money against it">
                    {order.payments.length} payment
                    {order.payments.length === 1 ? "" : "s"} totalling{" "}
                    {formatPaise(order.receivedPaise)} will be deleted with it.
                    What was destroyed is written to the audit trail first, but
                    the payment rows themselves do not come back.
                  </Notice>
                </div>
              ) : null}
              <ActionButton
                action={deleteOrderAction}
                variant="danger"
                pendingLabel="Deleting..."
                hidden={{ orderId: order.id }}
                confirm={
                  order.receivedPaise > 0
                    ? `Delete ${order.orderNo}? ${order.payments.length} payment(s) totalling ${formatPaise(order.receivedPaise)} go with it. This cannot be undone.`
                    : `Delete ${order.orderNo}? This cannot be undone.`
                }
              >
                Delete order
              </ActionButton>
            </Card>
          ) : null}

          {order.leadId ? (
            <p className="text-sm text-[var(--text-faint)]">
              This order came from{" "}
              <Link
                href={`/leads/${order.leadId}`}
                className="text-[var(--accent-text)] hover:underline"
              >
                its original lead
              </Link>
              , where the full timeline lives.
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}
