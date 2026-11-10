// One place for booking money maths, mirroring the database functions line_profit / line_sale / line_cost
// and the commission rule in private.line_compute. Work in whole paise (integers) parsed from the typed text,
// so the browser and Postgres (exact numeric, half away from zero) always round the same way.
// Pure module: no imports, so it can be unit-tested with plain Node.

export type MoneyParse =
  | { kind: "missing" }                 // empty / not typed
  | { kind: "invalid"; raw: string }    // typed, but not a number
  | { kind: "value"; paise: number };   // a number (zero included)

const CLEAN = /[,\s₹]/g;

/** Reads what staff typed: "11,000", "₹ 11000", "1,25,000.50", "Rs. 500" and plain numbers. Never guesses. */
export function parseMoney(x: unknown): MoneyParse {
  if (x === null || x === undefined) return { kind: "missing" };
  if (typeof x === "number") {
    if (!Number.isFinite(x)) return { kind: "invalid", raw: String(x) };
    return parseMoney(numberToPlain(x));
  }
  const raw = String(x);
  const s = raw.replace(CLEAN, "").replace(/^rs\.?/i, "");
  if (s === "") return { kind: "missing" };
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return { kind: "invalid", raw };
  const neg = m[1] === "-";
  const whole = m[2] === "" ? 0 : Number(m[2]);
  const frac = (m[3] ?? "").padEnd(3, "0");
  // round to paise, half away from zero, from the decimal digits (no floating point involved)
  let paise = whole * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) paise += 1;
  if (!Number.isSafeInteger(paise)) return { kind: "invalid", raw };
  return { kind: "value", paise: neg && paise !== 0 ? -paise : paise };
}

/** Shortest plain decimal text for a JS number (no exponent), e.g. 1e21 is refused upstream as unsafe. */
function numberToPlain(n: number): string {
  const s = String(n);
  if (!/e/i.test(s)) return s;
  return n.toFixed(20).replace(/\.?0+$/, "");
}

/** Live previews while typing: a readable amount in rupees, missing or unreadable shows as 0.
 *  Never use this to decide what to save; server actions check with moneyProblem() / strictAmount() first. */
export function amount(x: unknown): number {
  const p = parseMoney(x);
  return p.kind === "value" ? p.paise / 100 : 0;
}

/** For saving: rupees, 0 when missing, and an error (never a silent 0) when the text is not a number. */
export function strictAmount(x: unknown): number {
  const p = parseMoney(x);
  if (p.kind === "invalid") throw new InvalidAmountError(p.raw);
  return p.kind === "value" ? p.paise / 100 : 0;
}

/** For saving optional amounts: null when missing, rupees when given, an error when unreadable. */
export function optionalAmount(x: unknown): number | null {
  const p = parseMoney(x);
  if (p.kind === "invalid") throw new InvalidAmountError(p.raw);
  return p.kind === "value" ? p.paise / 100 : null;
}

export class InvalidAmountError extends Error {
  raw: string;
  constructor(raw: string) {
    super(`invalid_amount: "${raw.slice(0, 30)}" is not a number`);
    this.raw = raw;
  }
}

/** What is wrong with a typed amount, in plain words, or null. Missing is fine unless required. */
export function moneyProblem(label: string, x: unknown, opts: { required?: boolean; allowNegative?: boolean } = {}): string | null {
  const p = parseMoney(x);
  if (p.kind === "invalid") return `${label}: “${p.raw.slice(0, 20)}” is not an amount. Use digits, e.g. 12500 or 12,500.50.`;
  if (p.kind === "missing") return opts.required ? `${label} is needed.` : null;
  if (!opts.allowNegative && p.paise < 0) return `${label} can't be negative.`;
  return null;
}

const paiseOf = (x: unknown) => {
  const p = parseMoney(x);
  return p.kind === "value" ? p.paise : 0;
};
const rupees = (p: number) => p / 100;

/** Integer division rounded half away from zero (matches Postgres round() on exact numerics). */
function divRound(num: number, den: number): number {
  const q = Math.trunc(num / den);
  const r = num - q * den;
  if (Math.abs(r) * 2 >= Math.abs(den)) return q + Math.sign(num) * Math.sign(den);
  return q;
}

export type LineMoney = {
  status: string; selling_price: number | string | null; supplier_cost: number | string | null;
  commission_type: "amount" | "percent"; commission_value: number | string | null; base_fare?: number | string | null;
  refund_to_client?: number | string | null; refund_from_supplier?: number | string | null;
};

/** Commission in paise. Percent of the base fare when one is given (zero counts), otherwise of the supplier cost. */
export function commissionPaise(l: LineMoney): number {
  if (l.commission_type !== "percent") return paiseOf(l.commission_value);
  const bf = parseMoney(l.base_fare);
  const base = bf.kind === "value" ? bf.paise : paiseOf(l.supplier_cost);
  // value is stored as numeric(12,2): hundredths of a percent, as an integer
  const pct = paiseOf(l.commission_value);
  // Postgres: round(base_rupees * pct / 100, 2) == round(base_paise * pct_hundredths / 10000) paise
  return divRound(base * pct, 10000);
}

/** Commission in rupees (see commissionPaise). */
export function commissionOf(l: LineMoney) {
  return rupees(commissionPaise(l));
}

/** Profit as the CRM reports it everywhere.
 *  Active:    selling price + commission − supplier cost
 *  Cancelled: (selling price − refund to client) − (supplier cost − refund from supplier); commission is reversed. */
export function lineProfit(l: LineMoney) {
  if (l.status === "cancelled") {
    return rupees((paiseOf(l.selling_price) - paiseOf(l.refund_to_client)) - (paiseOf(l.supplier_cost) - paiseOf(l.refund_from_supplier)));
  }
  return rupees(paiseOf(l.selling_price) + commissionPaise(l) - paiseOf(l.supplier_cost));
}

/** Pieces of a cancelled booking, for showing the working. */
export function cancelBreakdown(l: LineMoney) {
  const kept = rupees(paiseOf(l.selling_price) - paiseOf(l.refund_to_client));
  const charge = rupees(Math.max(0, paiseOf(l.supplier_cost) - paiseOf(l.refund_from_supplier)));
  return { kept, charge, profit: lineProfit({ ...l, status: "cancelled" }) };
}
