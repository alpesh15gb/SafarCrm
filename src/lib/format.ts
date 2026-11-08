// Indian defaults: ₹ with lakh grouping, DD-MM-YYYY, IST.
const inrFmt = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2, minimumFractionDigits: 0 });
const numFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

export function inr(n: number | string | null | undefined) {
  if (n === null || n === undefined || n === "") return "—";
  return inrFmt.format(Number(n));
}
export function num(n: number | string | null | undefined) {
  if (n === null || n === undefined || n === "") return "";
  return numFmt.format(Number(n));
}

/** 'YYYY-MM-DD' or timestamp -> 'DD-MM-YYYY' (IST) */
export function fdate(v: string | null | undefined) {
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split("-");
    return `${d}-${m}-${y}`;
  }
  const p = istParts(new Date(v));
  return `${p.day}-${p.month}-${p.year}`;
}

export function fdatetime(v: string | null | undefined) {
  if (!v) return "";
  const p = istParts(new Date(v));
  return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
}

export function ftime(v: string | null | undefined) {
  if (!v) return "";
  const p = istParts(new Date(v));
  return `${p.hour}:${p.minute}`;
}

function istParts(d: Date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

/** Today's date in IST as YYYY-MM-DD */
export function todayIST(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  const p = istParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** datetime-local value (IST) -> ISO string */
export function istLocalToISO(v: string) {
  if (!v) return null;
  return new Date(v + ":00+05:30").toISOString();
}
/** ISO -> datetime-local value in IST */
export function isoToISTLocal(v: string | null | undefined) {
  if (!v) return "";
  const p = istParts(new Date(v));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

export function age(dob: string | null | undefined) {
  if (!dob) return null;
  const [y, m, d] = dob.split("-").map(Number);
  const [ty, tm, td] = todayIST().split("-").map(Number);
  let a = ty - y;
  if (tm < m || (tm === m && td < d)) a--;
  return a;
}

export function daysUntil(date: string | null | undefined) {
  if (!date) return null;
  const a = Date.parse(date + "T00:00:00Z");
  const b = Date.parse(todayIST() + "T00:00:00Z");
  return Math.round((a - b) / 86400000);
}

export function expiryLabel(date: string | null | undefined) {
  const n = daysUntil(date);
  if (n === null) return null;
  if (n < 0) return { text: `Expired ${fdate(date)}`, tone: "red" as const };
  if (n <= 31) return { text: `Expires in ${n} day${n === 1 ? "" : "s"}`, tone: "red" as const };
  const months = Math.floor(n / 30.4);
  if (months < 6) return { text: `Expires in ${months} month${months === 1 ? "" : "s"}`, tone: "amber" as const };
  return { text: `Valid till ${fdate(date)}`, tone: "grey" as const };
}

/** Normalise an Indian mobile to +91XXXXXXXXXX (leaves other country codes alone). */
export function normPhone(v: string | null | undefined) {
  if (!v) return "";
  const s = v.replace(/[^\d+]/g, "");
  if (s.startsWith("+")) return s;
  const d = s.replace(/\D/g, "");
  if (d.length === 10) return "+91" + d;
  if (d.length === 12 && d.startsWith("91")) return "+" + d;
  if (d.length === 11 && d.startsWith("0")) return "+91" + d.slice(1);
  return d ? "+" + d : "";
}
export function prettyPhone(v: string | null | undefined) {
  if (!v) return "";
  const m = v.match(/^\+91(\d{5})(\d{5})$/);
  return m ? `+91 ${m[1]} ${m[2]}` : v;
}
export function waLink(phone: string | null | undefined, text: string) {
  const d = (phone || "").replace(/\D/g, "");
  return `https://wa.me/${d}?text=${encodeURIComponent(text)}`;
}

/** Financial year (April–March) containing the given date */
export function fyRange(date = todayIST()) {
  const [y, m] = date.split("-").map(Number);
  const start = m >= 4 ? y : y - 1;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31`, label: `FY ${start}-${String(start + 1).slice(2)}` };
}
export function monthRange(offset = 0) {
  const [y, m] = todayIST().split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + offset, 1));
  const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { from: d.toISOString().slice(0, 10), to: e.toISOString().slice(0, 10) };
}

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("");
}

/** Portal logins use the client's mobile number; Supabase needs an email, so we derive one. */
export function portalEmail(mobile: string) {
  const d = normPhone(mobile).replace(/\D/g, "");
  return `m${d}@portal.safar.local`;
}
export function portalCodeEmail(code: string) {
  return `${code.toLowerCase().replace(/[^a-z0-9]/g, "")}@portal.safar.local`;
}

/** ₹ in Indian short form: ₹1.2 Cr, ₹4.5 L, ₹12 K */
export function inrShort(n: number) {
  const a = Math.abs(n), s = n < 0 ? "-" : "";
  if (a >= 1e7) return `${s}₹${+(a / 1e7).toFixed(a >= 1e8 ? 0 : 1)} Cr`;
  if (a >= 1e5) return `${s}₹${+(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)} L`;
  if (a >= 1e3) return `${s}₹${+(a / 1e3).toFixed(0)} K`;
  return `${s}₹${Math.round(a)}`;
}
