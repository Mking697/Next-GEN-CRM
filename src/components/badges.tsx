import { Badge } from "./ui";
import {
  LEAD_SOURCE_LABEL,
  LEAD_STATUS_LABEL,
  ORDER_STAGE_LABEL,
  PAYMENT_STATE_LABEL,
  type PaymentState,
} from "@/server/order-state";
import type {
  LeadSource,
  LeadStatus,
  MirrorStatus,
  OrderStage,
  QuotationStatus,
} from "@/generated/prisma/enums";

export function StatusBadge({ status }: { status: LeadStatus }) {
  const tone =
    status === "ORDER_CONFIRMED"
      ? "ok"
      : status === "LOST"
        ? "danger"
        : status === "FOLLOW_UP"
          ? "warn"
          : "neutral";
  return <Badge tone={tone}>{LEAD_STATUS_LABEL[status]}</Badge>;
}

export function SourceBadge({ source }: { source: LeadSource }) {
  return <Badge tone="accent">{LEAD_SOURCE_LABEL[source]}</Badge>;
}

/**
 * An order that lost its CRE to a deletion keeps stage WITH_CRE, exactly as
 * the transfer rule requires. Saying so here is what stops that looking like
 * a bug on the screen.
 */
export function StageBadge({
  stage,
  hasCre,
}: {
  stage: OrderStage;
  hasCre: boolean;
}) {
  if (stage === "WITH_CRE" && !hasCre) {
    return <Badge tone="warn">With CRE &middot; needs re-handover</Badge>;
  }
  const tone =
    stage === "CLOSED" ? "ok" : stage === "WITH_CRE" ? "accent" : "neutral";
  return <Badge tone={tone}>{ORDER_STAGE_LABEL[stage]}</Badge>;
}

export function PaymentBadge({ state }: { state: PaymentState }) {
  const tone =
    state === "PAID" ? "ok" : state === "PARTIAL" ? "warn" : "neutral";
  return <Badge tone={tone}>{PAYMENT_STATE_LABEL[state]}</Badge>;
}

const QUOTATION_LABEL: Record<QuotationStatus, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
};

export function QuotationBadge({ status }: { status: QuotationStatus }) {
  const tone =
    status === "ACCEPTED"
      ? "ok"
      : status === "REJECTED" || status === "EXPIRED"
        ? "danger"
        : status === "SENT"
          ? "accent"
          : "neutral";
  return <Badge tone={tone}>{QUOTATION_LABEL[status]}</Badge>;
}

/**
 * Whether the Google Sheet and Drive have caught up. The database is the
 * source of truth, so a lagging mirror is information, not an error state.
 */
export function MirrorBadge({ status }: { status: MirrorStatus }) {
  if (status === "SYNCED") return <Badge tone="ok">On Sheet</Badge>;
  if (status === "FAILED") return <Badge tone="danger">Sheet failed</Badge>;
  if (status === "DISABLED") return <Badge>Sheet off</Badge>;
  return <Badge tone="warn">Sheet pending</Badge>;
}
