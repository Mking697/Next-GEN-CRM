import "server-only";
import { after } from "next/server";
import { prisma } from "@/lib/db";
import { env, isDriveEnabled, isGoogleEnabled } from "@/lib/env";
import { formatDate, formatDateTime } from "@/lib/dates";
import { toPaise } from "@/lib/money";
import { formatQtyMilli } from "@/lib/quotation-math";
import {
  appendRow,
  GoogleError,
  replacePdf,
  uploadPdf,
  writeRow,
} from "@/lib/google";
import { getQuotation, SYSTEM_VIEWER } from "./quotations";
import { pdfFileName, renderQuotationPdf } from "./quotation-pdf";

/**
 * Mirroring a quotation to Google.
 *
 * The order of operations is the whole design. The quotation is already saved
 * in Postgres before any of this runs, so Google being slow, rate limited or
 * down cannot lose a quotation or block a CRE. The mirror is allowed to be
 * behind, it records why when it fails, and it can be retried.
 *
 * Nothing here throws to the caller: failures are written onto the quotation
 * as sheetStatus FAILED plus a readable reason, which is what the Quotations
 * page and the Lead sources page show.
 */

const HEADER = [
  "Timestamp",
  "Ref No",
  "Status",
  "Salesman",
  "CRE",
  "Party Name",
  "Contact Person",
  "Customer Mobile",
  "Customer Email",
  "Customer GST",
  "Billing Address",
  "Shipping Address",
  "Line Items",
  "Sub Total",
  "Freight",
  "GST %",
  "GST Amount",
  "Quotation Amount",
  "Order No",
  "Order Stage",
  "Order Received",
  "Order Due",
  "Quotation PDF URL",
];

function addressText(address: {
  street: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string | null;
}): string {
  return [
    address.street,
    address.city,
    address.state,
    address.pincode,
    address.country,
  ]
    .filter((part) => part && part.trim().length > 0)
    .join(", ");
}

/** Rupees as a plain number, so the Sheet can total the column itself. */
function rupees(paise: number): number {
  return Math.round(paise) / 100;
}

// ---------------------------------------------------------------------------

export interface MirrorResult {
  ok: boolean;
  message: string;
  pdfUrl?: string;
}

/**
 * Push one quotation to Drive and the Sheet.
 *
 * Re-mirroring an already-mirrored quotation overwrites the same file and the
 * same row rather than appending a second one, so the Sheet holds one live
 * line per quotation instead of a history of every edit.
 */
export async function mirrorQuotation(id: string): Promise<MirrorResult> {
  if (!isGoogleEnabled()) {
    await prisma.quotation
      .update({
        where: { id },
        data: { sheetStatus: "DISABLED", sheetError: null },
      })
      .catch(() => {});
    return { ok: false, message: "Google is not configured." };
  }

  const quotation = await getQuotation(SYSTEM_VIEWER, id);
  if (!quotation) return { ok: false, message: "That quotation no longer exists." };

  try {
    // -- 1. the PDF ------------------------------------------------------
    let pdfUrl = quotation.pdfUrl;

    if (isDriveEnabled()) {
      const pdf = await renderQuotationPdf(quotation, {
        dateText: formatDate(quotation.createdAt),
        validText: quotation.validUntil ? formatDate(quotation.validUntil) : null,
      });
      const name = pdfFileName(quotation.quoteNo, quotation.partyName);
      const existingId = fileIdFromUrl(pdfUrl);

      if (existingId) {
        await replacePdf(existingId, pdf);
      } else {
        const uploaded = await uploadPdf(name, pdf);
        pdfUrl = uploaded.url;
      }
    }

    // -- 2. the order, if one has been placed ------------------------------
    const order = quotation.orderId
      ? await prisma.order.findUnique({
          where: { id: quotation.orderId },
          select: {
            orderNo: true,
            stage: true,
            amountPaise: true,
            payments: { select: { amountPaise: true } },
          },
        })
      : null;

    const received =
      order?.payments.reduce((sum, p) => sum + toPaise(p.amountPaise), 0) ?? 0;
    const due = order ? Math.max(0, toPaise(order.amountPaise) - received) : 0;

    // -- 3. the row --------------------------------------------------------
    const row: (string | number)[] = [
      formatDateTime(quotation.createdAt),
      quotation.quoteNo,
      quotation.status,
      quotation.salesmanName ?? "",
      quotation.creName,
      quotation.partyName,
      quotation.contactPerson ?? "",
      quotation.customerMobile ?? "",
      quotation.customerEmail ?? "",
      quotation.customerGst ?? "",
      addressText(quotation.billing),
      addressText(quotation.shipping),
      quotation.items
        .map(
          (item, index) =>
            `${index + 1}. ${[item.particular, item.panelThickness, item.specs]
              .filter(Boolean)
              .join(" / ")} - ${formatQtyMilli(item.qtyMilli)} ${item.uom} @ ${rupees(item.ratePaise)} = ${rupees(item.amountPaise)}`,
        )
        .join("\n"),
      rupees(quotation.totals.subTotalPaise),
      rupees(quotation.totals.freightPaise),
      quotation.totals.gstPercent,
      rupees(quotation.totals.gstPaise),
      rupees(quotation.totals.payablePaise),
      order?.orderNo ?? "",
      order?.stage ?? "",
      order ? rupees(received) : "",
      order ? rupees(due) : "",
      pdfUrl ?? "",
    ];

    const tab = env.GOOGLE_SHEET_QUOTATIONS_TAB;
    let rowNumber = quotation.sheetRowNumber;

    if (rowNumber) {
      await writeRow(tab, rowNumber, row);
    } else {
      const appended = await appendRow(tab, HEADER, row);
      rowNumber = appended.rowNumber;
    }

    await prisma.quotation.update({
      where: { id },
      data: {
        pdfUrl,
        sheetRow: rowNumber,
        sheetStatus: "SYNCED",
        sheetSyncedAt: new Date(),
        sheetError: null,
      },
    });

    return {
      ok: true,
      message: `${quotation.quoteNo} mirrored to the Sheet.`,
      pdfUrl: pdfUrl ?? undefined,
    };
  } catch (error) {
    const message =
      error instanceof GoogleError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);

    await prisma.quotation
      .update({
        where: { id },
        data: { sheetStatus: "FAILED", sheetError: message.slice(0, 500) },
      })
      .catch(() => {});

    console.error(`[mirror] ${id} failed:`, message);
    return { ok: false, message };
  }
}

/**
 * Run the mirror after the response has already gone back to the browser.
 *
 * Rendering a PDF and making two Google calls takes seconds. Doing that inside
 * the action would make "Mark as sent" feel broken, and it would tie the
 * success of a database write to the availability of a third party.
 */
export function queueMirror(id: string): void {
  if (!isGoogleEnabled()) return;
  after(async () => {
    await mirrorQuotation(id).catch((error) => {
      console.error("[mirror] background run threw", error);
    });
  });
}

/**
 * Sweep up whatever the background runs did not manage. Called by the cron
 * route, so a Google outage repairs itself once the outage ends.
 */
export async function retryPendingMirrors(
  limit = 10,
): Promise<{ attempted: number; succeeded: number }> {
  if (!isGoogleEnabled()) return { attempted: 0, succeeded: 0 };

  const stale = await prisma.quotation.findMany({
    where: {
      sheetStatus: { in: ["PENDING", "FAILED"] },
      status: { in: ["SENT", "ACCEPTED"] },
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true },
  });

  let succeeded = 0;
  for (const quotation of stale) {
    const result = await mirrorQuotation(quotation.id);
    if (result.ok) succeeded += 1;
  }

  return { attempted: stale.length, succeeded };
}

/** https://drive.google.com/file/d/<id>/view -> <id> */
function fileIdFromUrl(url: string | null): string | null {
  if (!url) return null;
  const match = /\/d\/([A-Za-z0-9_-]+)/.exec(url);
  return match?.[1] ?? null;
}
