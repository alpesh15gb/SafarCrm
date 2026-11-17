export type ReportParams = Record<string, string | undefined>;

export function reportUses(key: string) {
  const bookings = ["pnl", "sales", "upcoming"].includes(key);
  const cashbook = key === "cashbook";
  const clients = ["client_dues", "client_credits"].includes(key);
  return {
    date: bookings || cashbook,
    account: cashbook,
    service: bookings,
    staff: bookings || clients,
    supplier: bookings || key === "supplier_dues",
    customer: bookings || clients,
  };
}

/** Keep the displayed controls, report queries and Excel link on the same active filters. */
export function reportParams(key: string, input: ReportParams): ReportParams {
  const uses = reportUses(key);
  const result: ReportParams = { r: key };
  for (const field of ["service", "staff", "supplier", "customer"] as const) {
    if (uses[field] && input[field]) result[field] = input[field];
  }
  if (result.customer && input.cname) result.cname = input.cname;
  if (uses.date && input.range) {
    result.range = input.range;
    if (input.range === "custom") {
      result.from = input.from;
      result.to = input.to;
    }
  }
  if (key === "expiry" && input.months) result.months = input.months;
  if (uses.account && input.account) result.account = input.account;
  return result;
}

/** report_client_dues returns elapsed days, which are negative for a future due date. */
export function clientDueTiming(days: unknown): string {
  if (days === null || days === undefined || days === "") return "";
  const elapsed = Number(days);
  if (!Number.isFinite(elapsed)) return "";
  const count = Math.abs(elapsed);
  const unit = count === 1 ? "day" : "days";
  if (elapsed < 0) return `Due in ${count} ${unit}`;
  if (elapsed === 0) return "Due today";
  return `${count} ${unit} overdue`;
}
