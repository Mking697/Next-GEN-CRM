import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { formatDateTime } from "@/lib/dates";
import { formatPaise } from "@/lib/money";
import { formatQtyMilli } from "@/lib/quotation-math";
import { getQuotation } from "@/server/quotations";
import { getRevision } from "@/server/quotation-revisions";
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

export const metadata: Metadata = { title: "Archived quotation" };

/**
 * One archived version of a quotation, read-only.
 *
 * A quotation keeps its reference number for its whole life, including after
 * an order has been placed and the document re-priced. That only works if the
 * version being replaced is still readable, which is what this page is: the
 * snapshot exactly as it stood when somebody pressed save.
 *
 * Scope comes from getQuotation() first. getRevision() is keyed on the
 * quotation id and applies none of its own, so resolving the parent is what
 * stops a revision being read through a guessed URL.
 */
export default async function RevisionPage({
  params,
}: {
  params: Promise<{ id: string; revision: string }>;
}) {
  const { id, revision } = await params;
  const user = await requireUser(`/quotations/${id}/revisions/${revision}`);

  const quotation = await getQuotation(user, id);
  if (!quotation) notFound();

  const number = Number(revision);
  if (!Number.isInteger(number) || number < 1) notFound();

  const archived = await getRevision(quotation.id, number);
  if (!archived) notFound();

  const snapshot = archived.snapshot;
  const isCurrent = archived.revision === archived.latestRevision;

  return (
    <>
      <PageHeader
        title={`${quotation.quoteNo} · ${
          archived.revision === 1 ? "Original" : `Rework ${archived.revision - 1}`
        }`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <span>{snapshot.partyName}</span>
            <Badge tone={isCurrent ? "accent" : "neutral"}>
              {isCurrent ? "Current version" : "Superseded"}
            </Badge>
            <span className="text-[var(--text-faint)]">
              saved by {archived.actorEmail ?? archived.actorName ?? "somebody"}{" "}
              on {formatDateTime(archived.createdAt)}
            </span>
          </span>
        }
        action={
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`/quotations/${quotation.id}`}>
              Back to the quotation
            </LinkButton>
            {archived.revision > 1 ? (
              <LinkButton
                href={`/quotations/${quotation.id}/revisions/${archived.revision - 1}`}
                variant="ghost"
              >
                Previous
              </LinkButton>
            ) : null}
            {archived.revision < archived.latestRevision ? (
              <LinkButton
                href={`/quotations/${quotation.id}/revisions/${archived.revision + 1}`}
                variant="ghost"
              >
                Next
              </LinkButton>
            ) : null}
          </div>
        }
      />

      {!isCurrent ? (
        <div className="mb-4">
          <Notice tone="warn" title="This is not the live document">
            Version {archived.revision} of {archived.latestRevision}. The
            quotation itself, the PDF and the order all carry the latest
            version; this is kept so the change can be read back.
          </Notice>
        </div>
      ) : null}

      <Card className="mb-4">
        <CardHeader
          title="Customer"
          hint="As recorded on this version, not as it stands today."
        />
        <div className="grid gap-x-8 gap-y-2 text-base sm:grid-cols-2">
          <Detail label="Party">{snapshot.partyName}</Detail>
          <Detail label="Contact">{snapshot.contactPerson}</Detail>
          <Detail label="Mobile">{snapshot.customerMobile}</Detail>
          <Detail label="Email">{snapshot.customerEmail}</Detail>
          <Detail label="GST">{snapshot.customerGst}</Detail>
          <Detail label="Status">{snapshot.status}</Detail>
          <Detail label="Billing">{snapshot.billing}</Detail>
          <Detail label="Shipping">{snapshot.shipping}</Detail>
        </div>
      </Card>

      <Card className="mb-4">
        <CardHeader
          title={`Line items (${snapshot.items.length})`}
          hint={
            archived.changes.length > 0
              ? "What changed to produce this version is listed at the bottom."
              : "The quotation as it was first saved."
          }
        />
        <div className="overflow-x-auto">
          <Table>
            <thead>
              <tr>
                <Th>Particular</Th>
                <Th>Panel</Th>
                <Th>Specs</Th>
                <Th>Sheet</Th>
                <Th>Description</Th>
                <Th>UOM</Th>
                <Th align="right">Qty</Th>
                <Th align="right">Rate</Th>
                <Th align="right">Amount</Th>
              </tr>
            </thead>
            <tbody>
              {snapshot.items.map((item, index) => (
                <tr key={index}>
                  <Td>{item.particular || "-"}</Td>
                  <Td>{item.panelThickness || "-"}</Td>
                  <Td>{item.specs || "-"}</Td>
                  <Td>{item.sheetThickness || "-"}</Td>
                  <Td className="whitespace-pre-line">
                    {item.description || "-"}
                  </Td>
                  <Td>{item.uom || "-"}</Td>
                  <Td align="right" numeric>
                    {formatQtyMilli(item.qtyMilli)}
                    {/* The working, where there was any. An archived version
                        is no use if it only kept the answer. */}
                    {item.qtyFormula ? (
                      <div className="text-2xs text-[var(--text-faint)]">
                        = {item.qtyFormula}
                      </div>
                    ) : null}
                  </Td>
                  <Td align="right" numeric>
                    {formatPaise(item.ratePaise)}
                  </Td>
                  <Td align="right" numeric>
                    {formatPaise(item.amountPaise)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>

        <dl className="mt-4 ml-auto max-w-xs space-y-1.5 text-base">
          <Money label="Sub total" paise={snapshot.subTotalPaise} />
          <Money label="Freight charges" paise={snapshot.freightPaise} />
          <Money
            label={`GST ${snapshot.gstPercent}%`}
            paise={snapshot.gstPaise}
          />
          <div className="flex justify-between border-t pt-1.5 font-medium">
            <dt>Payable amount</dt>
            <dd className="tnum">{formatPaise(snapshot.payablePaise)}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <CardHeader title="Document text" />
        <div className="space-y-3 text-base">
          <Detail label="Subject">{snapshot.subject}</Detail>
          <Detail label="Note">{snapshot.note}</Detail>
          <div>
            <dt className="text-sm text-[var(--text-faint)]">
              Terms and conditions
            </dt>
            <dd className="mt-1 whitespace-pre-line leading-relaxed">
              {snapshot.terms || "-"}
            </dd>
          </div>
        </div>

        {archived.changes.length > 0 ? (
          <div className="mt-4 border-t pt-3">
            <p className="text-sm font-medium">
              What changed to produce this version
            </p>
            <ul className="mt-1.5 space-y-1">
              {archived.changes.map((change, index) => (
                <li
                  key={index}
                  className="flex gap-2 text-sm text-[var(--text-muted)]"
                >
                  <span
                    aria-hidden
                    className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-[var(--border-strong)]"
                  />
                  <span>{change}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Card>
    </>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-sm text-[var(--text-faint)]">{label}</dt>
      <dd className="whitespace-pre-line">{children || "-"}</dd>
    </div>
  );
}

function Money({ label, paise }: { label: string; paise: number }) {
  return (
    <div className="flex justify-between">
      <dt className="text-[var(--text-muted)]">{label}</dt>
      <dd className="tnum">{formatPaise(paise)}</dd>
    </div>
  );
}
