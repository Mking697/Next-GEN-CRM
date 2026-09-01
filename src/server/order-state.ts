import { toPaise } from "@/lib/money";

/**
 * Payment state is DERIVED, never stored.
 *
 * There is no `paymentState` column anywhere in the schema on purpose. The
 * only truth is the sum of the Payment rows against an order, so the state
 * cannot drift out of sync with the money, and deleting a mistaken payment
 * automatically walks the order back from PAID to PARTIAL.
 */

export type PaymentState = "UNPAID" | "PARTIAL" | "PAID";

export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  UNPAID: "Unpaid",
  PARTIAL: "Partly paid",
  PAID: "Paid",
};

export function derivePaymentState(
  amountPaise: number,
  receivedPaise: number,
): PaymentState {
  if (receivedPaise <= 0) return "UNPAID";
  if (receivedPaise >= amountPaise) return "PAID";
  return "PARTIAL";
}

export interface OrderMoney {
  amountPaise: number;
  receivedPaise: number;
  duePaise: number;
  paymentState: PaymentState;
  /** 0-100, clamped. For progress bars. */
  percentReceived: number;
}

/** Fold an order's amount and its payment rows into the money view. */
export function orderMoney(
  amount: bigint | number,
  payments: { amountPaise: bigint | number }[],
): OrderMoney {
  const amountPaise = toPaise(amount);
  const receivedPaise = payments.reduce(
    (sum, payment) => sum + toPaise(payment.amountPaise),
    0,
  );
  return summarise(amountPaise, receivedPaise);
}

/** Same fold, when the sum already came back from a database aggregate. */
export function summarise(
  amountPaise: number,
  receivedPaise: number,
): OrderMoney {
  const duePaise = Math.max(0, amountPaise - receivedPaise);
  return {
    amountPaise,
    receivedPaise,
    duePaise,
    paymentState: derivePaymentState(amountPaise, receivedPaise),
    percentReceived:
      amountPaise <= 0
        ? 0
        : Math.min(100, Math.round((receivedPaise / amountPaise) * 100)),
  };
}

/** An order may be closed only when nothing is due. */
export function canClose(money: OrderMoney): boolean {
  return money.duePaise === 0 && money.amountPaise > 0;
}

export const ORDER_STAGE_LABEL = {
  CONFIRMED: "Confirmed",
  WITH_CRE: "With CRE",
  CLOSED: "Closed",
} as const;

export const LEAD_STATUS_LABEL = {
  NEW: "New",
  FOLLOW_UP: "Following up",
  ORDER_CONFIRMED: "Order confirmed",
  LOST: "Lost",
} as const;

export const LEAD_SOURCE_LABEL = {
  INDIAMART: "IndiaMART",
  META: "Meta",
  MANUAL: "Manual",
} as const;

export const PAYMENT_MODE_LABEL = {
  CASH: "Cash",
  UPI: "UPI",
  BANK_TRANSFER: "Bank transfer",
  CHEQUE: "Cheque",
  CARD: "Card",
  OTHER: "Other",
} as const;
