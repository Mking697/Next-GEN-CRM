import "server-only";
import {
  Document,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { Letterhead } from "./letterhead";
import { formatQtyMilli } from "@/lib/quotation-math";
import type { QuotationDetail } from "./quotations";

/**
 * The quotation PDF.
 *
 * Drawn with @react-pdf/renderer rather than by printing HTML, because HTML to
 * PDF on a server needs a headless Chromium: roughly 300MB of binary, a
 * platform-specific download, and a process to babysit. This is 2MB of plain
 * JavaScript that runs anywhere Node runs, which matters on a shared Node
 * slot.
 *
 * A4 landscape, matching the print stylesheet the old system used, so the
 * document a customer receives looks like the one they are used to.
 */

// Helvetica, the built-in font, has no rupee glyph. Rather than ship a font
// file for one character, money is written "Rs." here. It is unambiguous on an
// Indian quotation and it renders identically on every reader.
function money(paise: number, decimals = true): string {
  const negative = paise < 0;
  const absolute = Math.abs(Math.trunc(paise));
  const rupees = Math.trunc(absolute / 100);
  const remainder = absolute % 100;

  const digits = String(rupees);
  const grouped =
    digits.length <= 3
      ? digits
      : digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",") +
        "," +
        digits.slice(-3);

  return `${negative ? "-" : ""}Rs. ${grouped}${
    decimals ? "." + String(remainder).padStart(2, "0") : ""
  }`;
}

const COLORS = {
  ink: "#1a1a1a",
  muted: "#555555",
  faint: "#888888",
  line: "#000000",
  headBg: "#eeeeee",
  totalBg: "#fff8dc",
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 18,
    paddingBottom: 28,
    paddingHorizontal: 18,
    fontSize: 8,
    fontFamily: "Helvetica",
    color: COLORS.ink,
  },

  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    borderBottomWidth: 1.5,
    borderBottomColor: COLORS.line,
    paddingBottom: 8,
    marginBottom: 8,
  },
  headerLeft: { flexDirection: "row", gap: 10, flexGrow: 1, flexShrink: 1 },
  logo: { width: 46, height: 46, objectFit: "contain" },
  companyName: { fontSize: 13, fontFamily: "Helvetica-Bold" },
  companyLine: { fontSize: 7.5, color: COLORS.muted, marginTop: 1.5 },
  headerRight: { alignItems: "flex-end", width: 150 },
  docTitle: { fontSize: 15, fontFamily: "Helvetica-Bold" },

  boxes: { flexDirection: "row", gap: 8, marginBottom: 8 },
  box: {
    flexGrow: 1,
    flexBasis: 0,
    borderWidth: 0.75,
    borderColor: COLORS.line,
    padding: 6,
  },
  boxTitle: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginBottom: 3,
  },
  boxLine: { fontSize: 8, marginBottom: 1.5 },

  subject: {
    borderWidth: 0.75,
    borderColor: COLORS.line,
    padding: 6,
    marginBottom: 8,
  },

  table: { borderWidth: 0.75, borderColor: COLORS.line },
  tr: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: COLORS.line },
  trLast: { flexDirection: "row" },
  th: {
    backgroundColor: COLORS.headBg,
    fontFamily: "Helvetica-Bold",
    fontSize: 7,
    padding: 4,
    borderRightWidth: 0.5,
    borderRightColor: COLORS.line,
    textAlign: "center",
  },
  td: {
    fontSize: 7.5,
    padding: 4,
    borderRightWidth: 0.5,
    borderRightColor: COLORS.line,
  },

  totalsWrap: { flexDirection: "row", justifyContent: "flex-end", marginTop: 8 },
  totals: { width: 220 },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 2.5,
    paddingHorizontal: 6,
  },
  totalRowStrong: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
    paddingHorizontal: 6,
    backgroundColor: COLORS.totalBg,
    borderWidth: 0.75,
    borderColor: COLORS.line,
    marginTop: 2,
  },

  section: { marginTop: 10 },
  sectionTitle: { fontSize: 8.5, fontFamily: "Helvetica-Bold", marginBottom: 3 },
  body: { fontSize: 7.5, color: COLORS.muted, lineHeight: 1.45 },

  bank: {
    marginTop: 10,
    borderWidth: 0.75,
    borderColor: COLORS.line,
    padding: 6,
  },
  bankGrid: { flexDirection: "row", flexWrap: "wrap", gap: 2 },
  bankCell: { width: "33%", fontSize: 7.5, marginBottom: 1.5 },

  signature: { marginTop: 26, alignItems: "flex-end" },

  footer: {
    position: "absolute",
    bottom: 12,
    left: 18,
    right: 18,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 6.5,
    color: COLORS.faint,
  },
});

/** Column widths as percentages, adding up to 100. */
const COLS = [
  { key: "sno", label: "S.No", width: "4%", align: "center" as const },
  { key: "particular", label: "Particular", width: "15%", align: "left" as const },
  { key: "panelThickness", label: "Panel\nThickness", width: "8%", align: "center" as const },
  { key: "specs", label: "Specs", width: "9%", align: "center" as const },
  { key: "sheetThickness", label: "Sheet Thickness\n(Inner/Outer)", width: "10%", align: "center" as const },
  { key: "description", label: "Description", width: "25%", align: "left" as const },
  { key: "uom", label: "UOM", width: "5%", align: "center" as const },
  { key: "qty", label: "Qty", width: "6%", align: "right" as const },
  { key: "rate", label: "Rate", width: "8%", align: "right" as const },
  { key: "amount", label: "Amount", width: "11%", align: "right" as const },
];

function addressLines(address: {
  street: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  country: string | null;
}): string {
  return [
    address.street,
    [address.city, address.state].filter(Boolean).join(", "),
    [address.pincode, address.country].filter(Boolean).join(" "),
  ]
    .filter((line) => line && line.trim().length > 0)
    .join("\n");
}

function QuotationDocument({
  quotation,
  letterhead,
  dateText,
  validText,
}: {
  quotation: QuotationDetail;
  letterhead: Letterhead;
  dateText: string;
  validText: string | null;
}) {
  const { company, bank, logo } = letterhead;
  const { totals } = quotation;

  return (
    <Document
      title={`Quotation ${quotation.quoteNo} - ${quotation.partyName}`}
      author={company.name}
      subject={quotation.subject}
    >
      <Page size="A4" orientation="landscape" style={styles.page} wrap>
        {/* -- header -------------------------------------------------- */}
        <View style={styles.header} fixed>
          <View style={styles.headerLeft}>
            {logo ? <Image src={logo} style={styles.logo} /> : null}
            <View style={{ flexGrow: 1, flexShrink: 1 }}>
              <Text style={styles.companyName}>{company.name}</Text>
              <Text style={styles.companyLine}>{company.address}</Text>
              {/* One contact, and it is the salesman the quotation is issued
                  for - the person who owns the customer relationship. The CRE
                  who actually built it is kept on the record in the CRM but
                  never printed: to the customer there is one point of
                  contact, not two. */}
              <Text style={styles.companyLine}>
                Sales person: {quotation.salesmanName ?? "-"}
              </Text>
              <Text style={styles.companyLine}>
                {[quotation.salesmanMobile, quotation.salesmanEmail]
                  .filter(Boolean)
                  .join("  |  ")}
              </Text>
            </View>
          </View>

          <View style={styles.headerRight}>
            <Text style={styles.docTitle}>Quotation</Text>
            <Text style={styles.companyLine}>Reference: {quotation.quoteNo}</Text>
            <Text style={styles.companyLine}>Date: {dateText}</Text>
            {validText ? (
              <Text style={styles.companyLine}>Valid to: {validText}</Text>
            ) : null}
          </View>
        </View>

        {/* -- to / delivery ------------------------------------------- */}
        <View style={styles.boxes}>
          <View style={styles.box}>
            <Text style={styles.boxTitle}>To</Text>
            <Text style={[styles.boxLine, { fontFamily: "Helvetica-Bold" }]}>
              {quotation.partyName}
            </Text>
            {quotation.contactPerson ? (
              <Text style={styles.boxLine}>
                Kind Attn: {quotation.contactPerson}
              </Text>
            ) : null}
            <Text style={styles.boxLine}>
              {[
                quotation.customerMobile ? `Mobile: ${quotation.customerMobile}` : null,
                quotation.customerEmail ? `Email: ${quotation.customerEmail}` : null,
              ]
                .filter(Boolean)
                .join("  |  ") || " "}
            </Text>
            <Text style={styles.boxLine}>{addressLines(quotation.billing)}</Text>
            {quotation.customerGst ? (
              <Text style={styles.boxLine}>GST: {quotation.customerGst}</Text>
            ) : null}
          </View>

          <View style={styles.box}>
            <Text style={styles.boxTitle}>Delivery address</Text>
            {quotation.shipping.partyName ? (
              <Text style={[styles.boxLine, { fontFamily: "Helvetica-Bold" }]}>
                {quotation.shipping.partyName}
              </Text>
            ) : null}
            {quotation.shipping.contactPerson ? (
              <Text style={styles.boxLine}>
                Kind Attn: {quotation.shipping.contactPerson}
              </Text>
            ) : null}
            <Text style={styles.boxLine}>
              {addressLines(quotation.shipping) || "Same as billing address"}
            </Text>
          </View>
        </View>

        {/* -- subject -------------------------------------------------- */}
        {quotation.subject ? (
          <View style={styles.subject}>
            <Text style={styles.boxTitle}>Subject</Text>
            <Text style={{ fontSize: 8 }}>{quotation.subject}</Text>
          </View>
        ) : null}

        {/* -- line items ----------------------------------------------- */}
        <View style={styles.table}>
          <View style={styles.tr} fixed>
            {COLS.map((col) => (
              <Text
                key={col.key}
                style={[styles.th, { width: col.width }]}
              >
                {col.label}
              </Text>
            ))}
          </View>

          {quotation.items.map((item, index) => (
            <View
              key={item.id}
              style={index === quotation.items.length - 1 ? styles.trLast : styles.tr}
              wrap={false}
            >
              <Text style={[styles.td, { width: COLS[0]!.width, textAlign: "center" }]}>
                {index + 1}
              </Text>
              <Text style={[styles.td, { width: COLS[1]!.width }]}>
                {item.particular}
              </Text>
              <Text style={[styles.td, { width: COLS[2]!.width, textAlign: "center" }]}>
                {item.panelThickness}
              </Text>
              <Text style={[styles.td, { width: COLS[3]!.width, textAlign: "center" }]}>
                {item.specs}
              </Text>
              <Text style={[styles.td, { width: COLS[4]!.width, textAlign: "center" }]}>
                {item.sheetThickness}
              </Text>
              <Text style={[styles.td, { width: COLS[5]!.width }]}>
                {item.description}
              </Text>
              <Text style={[styles.td, { width: COLS[6]!.width, textAlign: "center" }]}>
                {item.uom}
              </Text>
              <Text style={[styles.td, { width: COLS[7]!.width, textAlign: "right" }]}>
                {formatQtyMilli(item.qtyMilli)}
              </Text>
              <Text style={[styles.td, { width: COLS[8]!.width, textAlign: "right" }]}>
                {money(item.ratePaise)}
              </Text>
              <Text
                style={[
                  styles.td,
                  { width: COLS[9]!.width, textAlign: "right", borderRightWidth: 0 },
                ]}
              >
                {money(item.amountPaise)}
              </Text>
            </View>
          ))}
        </View>

        {/* -- totals ---------------------------------------------------- */}
        <View style={styles.totalsWrap} wrap={false}>
          <View style={styles.totals}>
            <View style={styles.totalRow}>
              <Text>Sub total</Text>
              <Text>{money(totals.subTotalPaise)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text>Freight charges</Text>
              <Text>{money(totals.freightPaise)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text>
                GST {totals.gstPercent}% on {money(totals.gstBasePaise)}
              </Text>
              <Text>{money(totals.gstPaise)}</Text>
            </View>
            <View style={styles.totalRowStrong}>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>Payable amount</Text>
              <Text style={{ fontFamily: "Helvetica-Bold" }}>
                {money(totals.payablePaise)}
              </Text>
            </View>
          </View>
        </View>

        {/* -- note and terms -------------------------------------------- */}
        {quotation.note ? (
          <View style={styles.section} wrap={false}>
            <Text style={styles.sectionTitle}>Note</Text>
            <Text style={styles.body}>{quotation.note}</Text>
          </View>
        ) : null}

        {quotation.terms ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Terms &amp; Conditions</Text>
            <Text style={styles.body}>{quotation.terms}</Text>
          </View>
        ) : null}

        {/* -- bank ------------------------------------------------------ */}
        <View style={styles.bank} wrap={false}>
          <Text style={styles.sectionTitle}>
            Beneficiary: {bank.beneficiary}
          </Text>
          <View style={styles.bankGrid}>
            <Text style={styles.bankCell}>Bank: {bank.name}</Text>
            <Text style={styles.bankCell}>Account no.: {bank.account}</Text>
            <Text style={styles.bankCell}>IFSC: {bank.ifsc}</Text>
            <Text style={styles.bankCell}>Type: {bank.accountType}</Text>
            <Text style={styles.bankCell}>Branch: {bank.branch}</Text>
          </View>
        </View>

        <View style={styles.signature} wrap={false}>
          <Text style={{ fontSize: 8 }}>(Authorised Signatory)</Text>
        </View>

        <View style={styles.footer} fixed>
          <Text>
            {quotation.quoteNo} &middot; {quotation.partyName}
          </Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

export async function renderQuotationPdf(
  quotation: QuotationDetail,
  letterhead: Letterhead,
  formatted: { dateText: string; validText: string | null },
): Promise<Buffer> {
  return renderToBuffer(
    <QuotationDocument
      quotation={quotation}
      letterhead={letterhead}
      dateText={formatted.dateText}
      validText={formatted.validText}
    />,
  );
}

/** Quotation_REF-020_Acme Ltd.pdf, matching what the old system produced. */
export function pdfFileName(quoteNo: string, partyName: string): string {
  const safe = partyName.replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 80);
  return `Quotation_${quoteNo}_${safe || "customer"}.pdf`;
}
