import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { formatDate } from "@/lib/dates";
import { getQuotation } from "@/server/quotations";
import { pdfFileName, renderQuotationPdf } from "@/server/quotation-pdf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * The quotation PDF, generated on demand.
 *
 * Nothing is stored: the file is built from the current rows every time it is
 * asked for. That removes a whole class of bug where a stale PDF sitting in a
 * bucket disagrees with the quotation on screen, and it means editing a
 * quotation cannot leave an out-of-date file behind.
 *
 * Scope is the same as the quotation page, so a link cannot be used to read a
 * document the viewer could not otherwise open.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }
  if (!can(user.role, "quotation.pdf")) {
    return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  }

  const quotation = await getQuotation(user, id);
  if (!quotation) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const pdf = await renderQuotationPdf(quotation, {
      dateText: formatDate(quotation.createdAt),
      validText: quotation.validUntil ? formatDate(quotation.validUntil) : null,
    });

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${pdfFileName(
          quotation.quoteNo,
          quotation.partyName,
        )}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    console.error("[pdf] render failed", error);
    return NextResponse.json(
      { error: "Could not build the PDF" },
      { status: 500 },
    );
  }
}
