// Ticket import: the versioned shape of extracted data, the provider's JSON schema, normalisation into a reviewable
// draft, and the checks that flag missing, uncertain and contradictory values.
// Pure module (relative imports only) so it can be unit-tested with plain Node.
// Nothing here scores confidence: a value is either backed by the document (with a page and the text it came from),
// flagged by a check, or missing. Flags never publish anything; a person confirms.

import { dayOffset, isDate, isTime, sectorTimeIssues } from "../flight-time.ts";

export const SCHEMA_VERSION = "ticket-extract/1";
export const PARSER_VERSION = "safar-import/1.0";

/** One value with where it came from. `original` keeps the extracted text when a reviewer corrects it. */
export type Field = { value: string; page?: number | null; evidence?: string; original?: string; flag?: "missing" | "uncertain" | "conflict"; note?: string };

export type DraftSegment = {
  key: string;
  from: Field; to: Field; dep_date: Field; dep_time: Field; arr_date: Field; arr_time: Field;
  airline: Field; flight_no: Field; cabin: Field; baggage: Field; fare_basis: Field;
};
export type DraftTicket = { number: Field; segments: string[] };
export type DraftPassenger = { key: string; name_as_issued: Field; pax_type: Field; tickets: DraftTicket[] };
export type DraftAmount = { label: string; amount: Field; currency: Field; scope: "document" | "passenger" | "unknown"; passenger_key?: string };
export type DraftRef = { value: string; kind?: string; airline?: string; page?: number | null };

export type Draft = {
  schema_version: string;
  source: "provider" | "manual";
  document_kind: string;
  issue_date: Field;
  passengers: DraftPassenger[];
  segments: DraftSegment[];
  airline_pnrs: DraftRef[];
  supplier_refs: DraftRef[];
  amounts: DraftAmount[];
  provider_notes?: string;
};

// ------------------------------------------------------------------ provider JSON schema (strict, every field required)
const str = { type: "string" } as const;
const page = { type: "integer" } as const;
const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, required: Object.keys(props), properties: props });

export const PROVIDER_SCHEMA = obj({
  document_kind: { type: "string", enum: ["e_ticket", "itinerary", "invoice", "boarding_pass", "other"] },
  issue_date: str,
  passengers: {
    type: "array",
    items: obj({
      name_as_issued: str, pax_type: str, page, evidence: str,
      tickets: { type: "array", items: obj({ number: str, segment_refs: { type: "array", items: { type: "integer" } }, page }) },
    }),
  },
  airline_pnrs: { type: "array", items: obj({ value: str, airline: str, page }) },
  supplier_refs: { type: "array", items: obj({ value: str, kind: str, page }) },
  segments: {
    type: "array",
    items: obj({
      ref: { type: "integer" }, from: str, to: str, dep_date: str, dep_time: str, arr_date: str, arr_time: str,
      airline: str, flight_no: str, cabin: str, baggage: str, fare_basis: str, page, evidence: str,
    }),
  },
  amounts: {
    type: "array",
    items: obj({ label: str, amount: str, currency: str, scope: { type: "string", enum: ["document", "passenger", "unknown"] }, passenger_index: { type: "integer" }, page, evidence: str }),
  },
  uncertain: { type: "array", items: obj({ path: str, reason: str }) },
  notes: str,
});

export type ProviderOutput = {
  document_kind: string; issue_date: string;
  passengers: { name_as_issued: string; pax_type: string; page: number; evidence: string; tickets: { number: string; segment_refs: number[]; page: number }[] }[];
  airline_pnrs: { value: string; airline: string; page: number }[];
  supplier_refs: { value: string; kind: string; page: number }[];
  segments: { ref: number; from: string; to: string; dep_date: string; dep_time: string; arr_date: string; arr_time: string; airline: string; flight_no: string; cabin: string; baggage: string; fare_basis: string; page: number; evidence: string }[];
  amounts: { label: string; amount: string; currency: string; scope: "document" | "passenger" | "unknown"; passenger_index: number; page: number; evidence: string }[];
  uncertain: { path: string; reason: string }[];
  notes: string;
};

// ------------------------------------------------------------------ structural validation of what the provider returned
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isStr = (x: unknown) => typeof x === "string";
const isInt = (x: unknown) => typeof x === "number" && Number.isInteger(x);
const LIMITS = { passengers: 30, segments: 24, tickets: 30, refs: 20, amounts: 40, text: 400 };

/** Checks the provider's output against PROVIDER_SCHEMA by hand (no schema library is installed). */
export function validateProviderOutput(x: unknown): { ok: true; value: ProviderOutput } | { ok: false; error: string } {
  const bad = (e: string) => ({ ok: false as const, error: e });
  if (!isObj(x)) return bad("not an object");
  const arr = (k: string, max: number) => (Array.isArray(x[k]) && (x[k] as unknown[]).length <= max ? (x[k] as unknown[]) : null);
  if (!isStr(x.document_kind) || !isStr(x.issue_date) || !isStr(x.notes)) return bad("missing top-level text fields");
  const pax = arr("passengers", LIMITS.passengers), segs = arr("segments", LIMITS.segments), pnrs = arr("airline_pnrs", LIMITS.refs),
    refs = arr("supplier_refs", LIMITS.refs), amts = arr("amounts", LIMITS.amounts), unc = arr("uncertain", 100);
  if (!pax || !segs || !pnrs || !refs || !amts || !unc) return bad("missing or oversized lists");
  for (const p of pax) {
    if (!isObj(p) || !isStr(p.name_as_issued) || !isStr(p.pax_type) || !isInt(p.page) || !isStr(p.evidence) || !Array.isArray(p.tickets)) return bad("bad passenger");
    if ((p.tickets as unknown[]).length > LIMITS.tickets) return bad("too many tickets");
    for (const t of p.tickets as unknown[]) {
      if (!isObj(t) || !isStr(t.number) || !isInt(t.page) || !Array.isArray(t.segment_refs) || !(t.segment_refs as unknown[]).every(isInt)) return bad("bad ticket");
    }
  }
  for (const s of segs) {
    if (!isObj(s) || !isInt(s.ref) || !isInt(s.page)) return bad("bad segment");
    for (const k of ["from", "to", "dep_date", "dep_time", "arr_date", "arr_time", "airline", "flight_no", "cabin", "baggage", "fare_basis", "evidence"]) if (!isStr(s[k])) return bad(`bad segment ${k}`);
  }
  for (const r of [...pnrs, ...refs]) if (!isObj(r) || !isStr(r.value) || !isInt(r.page)) return bad("bad reference");
  for (const a of amts) if (!isObj(a) || !isStr(a.label) || !isStr(a.amount) || !isStr(a.currency) || !isStr(a.scope) || !isInt(a.page)) return bad("bad amount");
  for (const u of unc) if (!isObj(u) || !isStr(u.path) || !isStr(u.reason)) return bad("bad uncertainty note");
  return { ok: true, value: x as unknown as ProviderOutput };
}

// ------------------------------------------------------------------ normalisation (strings in, strings out; nothing invented)
const clip = (s: unknown, n = LIMITS.text) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const f = (value: unknown, pg?: number | null, evidence?: string): Field => {
  const v = clip(value, 120);
  return { value: v, ...(pg && pg > 0 ? { page: pg } : {}), ...(evidence ? { evidence: clip(evidence, 200) } : {}) };
};
/** Dates must already be YYYY-MM-DD from the document; anything else is kept as text for the reviewer, not guessed. */
const dateField = (v: string, pg?: number) => {
  const t = clip(v, 40);
  return isDate(t) || t === "" ? f(t, pg) : { ...f("", pg), original: t, flag: "uncertain" as const, note: `Read as “${t}”. Enter the date as shown on the ticket.` };
};
const timeField = (v: string, pg?: number) => {
  const t = clip(v, 20);
  const m = /^(\d{1,2})[:.]?(\d{2})$/.exec(t);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) return f(`${m[1].padStart(2, "0")}:${m[2]}`, pg);
  return t === "" ? f("", pg) : { ...f("", pg), original: t, flag: "uncertain" as const, note: `Read as “${t}”.` };
};
/** Ticket and reference identifiers stay strings: leading zeros and dashes matter (098-1234567890). */
export const normTicketNo = (s: string) => {
  const d = clip(s, 40).replace(/[^0-9]/g, "");
  return d.length === 13 ? `${d.slice(0, 3)}-${d.slice(3)}` : clip(s, 40);
};

/** An airport code must be the one printed. When the quoted ticket text shows airport codes in brackets, e.g.
 *  "Mumbai (BOM)", and the extracted code isn't among the codes in that text (a city code like MUM, say), the field is
 *  marked as a conflict, which blocks confirmation until someone fixes it. Nothing is replaced automatically. */
export function airportField(code: string, page: number, evidence: string, first: boolean): Field {
  const v = clip(code, 3).toUpperCase();
  const fld = f(v, page, first ? evidence : undefined);
  const ev = String(evidence ?? "").toUpperCase();
  const inText = new Set(ev.match(/\b[A-Z]{3}\b/g) ?? []);
  const bracketed = [...ev.matchAll(/\(([A-Z]{3})\)/g)].map((m) => m[1]);
  if (v && bracketed.length && !inText.has(v)) {
    fld.flag = "conflict";
    fld.note = `the ticket text shows ${Array.from(new Set(bracketed)).join(" / ")}`;
  }
  return fld;
}

/** "adult" / "Child" / "infant" → ADT / CHD / INF; codes and anything else are kept as written (upper-cased). */
const PAX: Record<string, string> = { ADULT: "ADT", ADT: "ADT", CHILD: "CHD", CHD: "CHD", CNN: "CHD", INFANT: "INF", INF: "INF" };
/** "6E-1234", "6e1234", "6E 1234" → "6E 1234"; "TA" + "101" printed apart → "TA 101". Anything else is kept as written. */
export function normFlightNo(no: string, airline = ""): string {
  const n = clip(no, 12).toUpperCase().replace(/[\s-]+/g, " ").trim();
  const joined = /^([A-Z0-9]{2})\s?(\d{1,4}[A-Z]?)$/.exec(n);
  if (joined) return `${joined[1]} ${joined[2]}`;
  if (/^\d{1,4}[A-Z]?$/.test(n) && /^[A-Z0-9]{2}$/i.test(clip(airline, 3))) return `${clip(airline, 2).toUpperCase()} ${n}`;
  return n;
}

const paxCode = (s: string) => { const t = clip(s, 10).toUpperCase(); return PAX[t] ?? t; };

export function toDraft(p: ProviderOutput): Draft {
  const segKey = new Map<number, string>();
  const segments: DraftSegment[] = p.segments.map((s, i) => {
    const key = `s${i + 1}`;
    segKey.set(s.ref, key);
    return {
      key,
      from: airportField(s.from, s.page, s.evidence, true), to: airportField(s.to, s.page, s.evidence, false),
      dep_date: dateField(s.dep_date, s.page), dep_time: timeField(s.dep_time, s.page),
      arr_date: dateField(s.arr_date, s.page), arr_time: timeField(s.arr_time, s.page),
      // "TA" + "101" printed apart is one flight number; nothing else is joined or guessed
      airline: f(s.airline, s.page),
      flight_no: f(normFlightNo(s.flight_no, s.airline), s.page),
      cabin: f(s.cabin, s.page), baggage: f(s.baggage, s.page), fare_basis: f(s.fare_basis, s.page),
    };
  });
  const passengers: DraftPassenger[] = p.passengers.map((x, i) => ({
    key: `p${i + 1}`,
    name_as_issued: f(x.name_as_issued, x.page, x.evidence),
    pax_type: f(paxCode(x.pax_type), x.page),
    tickets: x.tickets.map((t) => ({
      number: f(normTicketNo(t.number), t.page),
      // a ticket with no segment references covers every segment on the document
      segments: t.segment_refs.length ? t.segment_refs.map((r) => segKey.get(r)).filter((k): k is string => !!k) : segments.map((s) => s.key),
    })),
  }));
  const draft: Draft = {
    schema_version: SCHEMA_VERSION, source: "provider", document_kind: clip(p.document_kind, 20), issue_date: dateField(p.issue_date),
    passengers, segments,
    airline_pnrs: p.airline_pnrs.filter((r) => clip(r.value)).map((r) => ({ value: clip(r.value, 20).toUpperCase(), airline: clip(r.airline, 60), page: r.page || null })),
    supplier_refs: p.supplier_refs.filter((r) => clip(r.value)).map((r) => ({ value: clip(r.value, 40), kind: clip(r.kind, 40), page: r.page || null })),
    // amounts are evidence: kept exactly as printed, with currency and what they cover; never turned into prices
    amounts: p.amounts.filter((a) => clip(a.amount)).map((a) => ({
      label: clip(a.label, 60), amount: f(a.amount, a.page, a.evidence), currency: f(clip(a.currency, 3).toUpperCase(), a.page),
      scope: a.scope, ...(a.scope === "passenger" && passengers[a.passenger_index] ? { passenger_key: passengers[a.passenger_index].key } : {}),
    })),
    provider_notes: clip(p.notes, 600),
  };
  for (const u of p.uncertain) markUncertain(draft, u.path, clip(u.reason, 200));
  return draft;
}

/** The provider says "segments[1].arr_date" or "passengers[0].name_as_issued" is unsure: flag that field. */
function markUncertain(d: Draft, path: string, reason: string) {
  const m = /^(segments|passengers)\[(\d+)\]\.([a-z_]+)$/.exec(path.trim());
  if (!m) return;
  const list = m[1] === "segments" ? d.segments : d.passengers;
  const item = list[Number(m[2])] as unknown as Record<string, Field> | undefined;
  const fld = item?.[m[3]];
  if (fld && typeof fld === "object" && "value" in fld) { fld.flag = fld.flag ?? "uncertain"; fld.note = reason; }
}

export function emptyDraft(): Draft {
  const e = (): Field => ({ value: "" });
  return {
    schema_version: SCHEMA_VERSION, source: "manual", document_kind: "e_ticket", issue_date: e(),
    passengers: [{ key: "p1", name_as_issued: e(), pax_type: { value: "ADT" }, tickets: [{ number: e(), segments: ["s1"] }] }],
    segments: [{ key: "s1", from: e(), to: e(), dep_date: e(), dep_time: e(), arr_date: e(), arr_time: e(), airline: e(), flight_no: e(), cabin: e(), baggage: e(), fare_basis: e() }],
    airline_pnrs: [], supplier_refs: [], amounts: [],
  };
}

// ------------------------------------------------------------------ review checks
export type ReviewIssue = { path: string; tone: "red" | "amber"; text: string; blocking: boolean };

const IATA = /^[A-Z]{3}$/;
const FLIGHT = /^([A-Z0-9]{2})[\s-]?(\d{1,4}[A-Z]?)$/;

/** Everything a reviewer should look at. `blocking` items stop confirmation; the rest are warnings to check. */
export function reviewIssues(d: Draft): ReviewIssue[] {
  const out: ReviewIssue[] = [];
  const add = (path: string, tone: "red" | "amber", text: string, blocking = tone === "red") => out.push({ path, tone, text, blocking });
  if (!d.segments.length) add("segments", "red", "Add at least one flight.");
  if (!d.passengers.length) add("passengers", "red", "Add at least one passenger.");
  const keys = new Set(d.segments.map((s) => s.key));
  d.segments.forEach((s, i) => {
    const at = `Flight ${i + 1}`, p = `segments.${i}`;
    const from = s.from.value.toUpperCase(), to = s.to.value.toUpperCase();
    if (!IATA.test(from)) add(`${p}.from`, "red", `${at}: departure airport code missing (3 letters).`);
    if (!IATA.test(to)) add(`${p}.to`, "red", `${at}: arrival airport code missing (3 letters).`);
    if (IATA.test(from) && from === to) add(`${p}.to`, "red", `${at}: departs and arrives at the same airport.`);
    if (!isDate(s.dep_date.value)) add(`${p}.dep_date`, "red", `${at}: departure date missing.`);
    if (!s.arr_date.value) add(`${p}.arr_date`, "amber", `${at}: arrival date not on the ticket or not read. Leave it empty rather than guess.`, false);
    if (s.flight_no.value && !FLIGHT.test(s.flight_no.value.toUpperCase())) add(`${p}.flight_no`, "amber", `${at}: flight number “${s.flight_no.value}” looks unusual.`, false);
    if (s.dep_time.value && !isTime(s.dep_time.value)) add(`${p}.dep_time`, "red", `${at}: departure time should look like 06:45.`);
    if (s.arr_time.value && !isTime(s.arr_time.value)) add(`${p}.arr_time`, "red", `${at}: arrival time should look like 06:45.`);
    for (const iss of sectorTimeIssues({ date: s.dep_date.value, dep: s.dep_time.value, arr_date: s.arr_date.value, arr: s.arr_time.value }, at)) {
      if (iss.text.includes("arrival date not recorded")) continue;   // reported above in import words
      add(`${p}.arr_date`, iss.tone, iss.text, iss.tone === "red");
    }
    const prev = d.segments[i - 1];
    if (prev && isDate(prev.dep_date.value) && isDate(s.dep_date.value)) {
      const gap = dayOffset(prev.arr_date.value || prev.dep_date.value, s.dep_date.value);
      if (gap !== null && gap < 0) add(`${p}.dep_date`, "red", `${at} departs before flight ${i} arrives. Check the order and dates.`);
    }
    for (const k of ["from", "to"] as const) {
      if (s[k].flag === "conflict") add(`${p}.${k}`, "red", `${at}: ${k === "from" ? "departure" : "arrival"} airport ${s[k].value} doesn't match the ticket text (${s[k].note}). Use the code printed on the ticket.`);
    }
    for (const k of ["from", "to", "dep_date", "dep_time", "arr_date", "arr_time", "flight_no"] as const) {
      if (s[k].flag === "uncertain") add(`${p}.${k}`, "amber", `${at}: ${k.replace("_", " ")} is uncertain${s[k].note ? ` (${s[k].note})` : ""}.`, false);
    }
  });
  const seen = new Map<string, string>();
  d.passengers.forEach((x, i) => {
    const at = `Passenger ${i + 1}`, p = `passengers.${i}`;
    if (!x.name_as_issued.value.trim()) add(`${p}.name_as_issued`, "red", `${at}: name as issued is missing.`);
    if (x.name_as_issued.flag === "uncertain") add(`${p}.name_as_issued`, "amber", `${at}: name is uncertain${x.name_as_issued.note ? ` (${x.name_as_issued.note})` : ""}. Copy it exactly as printed.`, false);
    if (!x.tickets.some((t) => t.number.value.trim())) add(`${p}.tickets`, "amber", `${at}: no ticket number. Fine for an itinerary; a ticket should have one.`, false);
    x.tickets.forEach((t, j) => {
      const n = t.number.value.trim();
      if (!n) return;
      const digits = n.replace(/\D/g, "");
      // IATA e-tickets are 13 digits; some low-cost carriers (e.g. IndiGo agency tickets) print the PNR plus a digit
      // as the ticket number. Both are kept as printed; anything that isn't 13 digits is flagged for a check, not blocked.
      if (/[A-Za-z]/.test(n)) add(`${p}.tickets.${j}`, "amber", `${at}: ticket number “${n}” is not a 13-digit e-ticket number. Fine if that is what the ticket prints (some low-cost airlines use the PNR plus a digit); remove it if it was read from somewhere else.`, false);
      else if (digits.length !== 13) add(`${p}.tickets.${j}`, "amber", `${at}: ticket number ${n} is not 13 digits.`, false);
      if (seen.has(digits)) add(`${p}.tickets.${j}`, "red", `${at}: ticket number ${n} is also on ${seen.get(digits)}. One ticket belongs to one passenger.`);
      else seen.set(digits, at.toLowerCase());
      for (const sk of t.segments) if (!keys.has(sk)) add(`${p}.tickets.${j}`, "amber", `${at}: ticket ${n} points at a flight that isn't listed.`, false);
    });
  });
  if (!d.airline_pnrs.length && !d.passengers.some((x) => x.tickets.some((t) => t.number.value))) {
    add("airline_pnrs", "amber", "No airline PNR and no ticket number. Check this really is a booked ticket.", false);
  }
  d.amounts.forEach((a, i) => {
    if (!/^-?[\d,]+(\.\d+)?$/.test(a.amount.value.replace(/\s/g, ""))) add(`amounts.${i}`, "amber", `Amount “${a.amount.value}” (${a.label}) is not a plain number. It is kept as written, as evidence only.`, false);
    if (!a.currency.value) add(`amounts.${i}`, "amber", `${a.label || "An amount"} has no currency.`, false);
  });
  return out;
}

export const blockingIssues = (d: Draft) => reviewIssues(d).filter((x) => x.blocking);

/** Trip shape from the segments, as the booking form uses it. */
export function tripType(d: Draft): "one-way" | "return" | "multi-city" {
  const s = d.segments;
  if (s.length === 1) return "one-way";
  if (s.length === 2 && s[1].from.value === s[0].to.value && s[1].to.value === s[0].from.value) return "return";
  return "multi-city";
}

/** "SHARMA/RAHUL MR" → { last: "Sharma", first: "Rahul", title: "Mr" } for pre-filling a new person (the issued name itself is kept as is). */
export function splitIssuedName(name: string): { first: string; last: string; title: string } {
  const cap = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const t = name.trim().replace(/\s+/g, " ");
  // titles come last on airline-style names (SHARMA/RAHUL MR) and first on others (Mr Rahul Sharma)
  const titles = /\s(MR|MRS|MS|MISS|MSTR|DR|CHD|INF)\.?$/i;
  const lead = /^(MR|MRS|MS|MISS|MSTR|MASTER|DR)\.?\s+/i;
  const title = titles.exec(t)?.[1] ?? lead.exec(t)?.[1] ?? "";
  const core = t.replace(titles, "").replace(lead, "");
  if (core.includes("/")) {
    const [last, first] = core.split("/");
    return { last: cap(last.trim()), first: cap((first ?? "").trim()), title: cap(title) };
  }
  const parts = core.split(" ");
  return { first: cap(parts.slice(0, -1).join(" ") || parts[0]), last: parts.length > 1 ? cap(parts[parts.length - 1]) : "", title: cap(title) };
}
