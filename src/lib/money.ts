// One place for booking money maths, mirroring the database functions line_profit / line_sale / line_cost.
// Work in paise (integers) so the browser and Postgres always round the same way.

const paise = (x: unknown) => Math.round((Number(x) || 0) * 100);
const rupees = (p: number) => p / 100;

export type LineMoney = {
  status: string; selling_price: number | string; supplier_cost: number | string;
  commission_type: "amount" | "percent"; commission_value: number | string; base_fare?: number | string | null;
  refund_to_client?: number | string; refund_from_supplier?: number | string;
};

/** Commission in rupees: % of the base fare when given (flights), otherwise % of supplier cost. */
export function commissionOf(l: LineMoney) {
  if (l.commission_type !== "percent") return rupees(paise(l.commission_value));
  const base = Number(l.base_fare) > 0 ? Number(l.base_fare) : Number(l.supplier_cost) || 0;
  // Postgres: round(base * value / 100, 2)
  return Math.round(base * (Number(l.commission_value) || 0)) / 100;
}

/** Profit as the CRM reports it everywhere.
 *  Active:    selling price + commission − supplier cost
 *  Cancelled: (selling price − refund to client) − (supplier cost − refund from supplier); commission is reversed. */
export function lineProfit(l: LineMoney) {
  if (l.status === "cancelled") {
    return rupees((paise(l.selling_price) - paise(l.refund_to_client)) - (paise(l.supplier_cost) - paise(l.refund_from_supplier)));
  }
  return rupees(paise(l.selling_price) + paise(commissionOf(l)) - paise(l.supplier_cost));
}

/** Pieces of a cancelled booking, for showing the working. */
export function cancelBreakdown(l: LineMoney) {
  const kept = rupees(paise(l.selling_price) - paise(l.refund_to_client));
  const charge = rupees(Math.max(0, paise(l.supplier_cost) - paise(l.refund_from_supplier)));
  return { kept, charge, profit: lineProfit({ ...l, status: "cancelled" }) };
}
