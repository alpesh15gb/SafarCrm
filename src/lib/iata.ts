// IATA conventions used across the flight screens. Pure functions: safe on server and client.

export type Issue = { tone: "red" | "amber"; text: string };

/** "6e6311" or "6E-6311" → "6E 6311". Airline designator is 2 characters, flight number up to 4 digits. */
export function normFlightNo(v: string) {
  const s = v.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = s.match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
  return m && /[A-Z]/.test(m[1]) ? `${m[1]} ${m[2]}` : v.toUpperCase();
}
export const airlineCodeOf = (flightNo: string) => normFlightNo(flightNo).match(/^([A-Z0-9]{2}) /)?.[1] ?? null;

export function checkFlightNo(v: string): Issue | null {
  if (!v) return null;
  const n = normFlightNo(v);
  return /^[A-Z0-9]{2} \d{1,4}[A-Z]?$/.test(n) && /[A-Z]/.test(n.slice(0, 2))
    ? null : { tone: "amber", text: `Flight number “${v}” looks unusual. It is the 2-character airline code and up to 4 digits, like 6E 6311.` };
}

export function checkAirport(code: string, known: Set<string>): Issue | null {
  if (!code) return null;
  if (!/^[A-Z]{3}$/.test(code)) return { tone: "red", text: `Airport “${code}” must be a 3-letter code, like BOM.` };
  return known.has(code) ? null : { tone: "amber", text: `We don't know airport code ${code}. Please check it. A typo here can create a wrong “international trip” reminder.` };
}

/** Airline PNR / record locator: usually 6 letters and numbers. */
export function checkPnr(v: string): Issue | null {
  if (!v) return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(s) ? null : { tone: "amber", text: `PNR “${v}” is usually 6 letters and numbers. Please check it.` };
}

/** Ticket number: 3-digit airline code + 10-digit serial = 13 digits. A conjunction ticket may end in -1 or -12. */
export function normTicket(v: string) {
  const s = v.replace(/\s/g, "");
  const m = s.replace(/^(\d{3})-/, "$1").match(/^(\d{3})(\d{10})(-\d{1,2})?$/);
  return m ? `${m[1]}-${m[2]}${m[3] ?? ""}` : v.trim();
}
export function checkTicket(v: string): Issue | null {
  if (!v) return null;
  const digits = v.replace(/-\d{1,2}$/, "").replace(/\D/g, "");
  if (/[^\d\s-]/.test(v)) return { tone: "red", text: `Ticket number “${v}” should only have digits.` };
  return digits.length === 13 ? null : { tone: "red", text: `Ticket numbers have 13 digits (3 for the airline + 10). This one has ${digits.length}.` };
}

/** Adult / child / infant on the date of travel (airline rule of thumb: infant under 2, child 2–11). */
export function paxType(dob: string | null | undefined, onDate: string): "ADT" | "CHD" | "INF" | null {
  if (!dob) return null;
  const [y, m, d] = dob.split("-").map(Number);
  const [ty, tm, td] = onDate.split("-").map(Number);
  const age = ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
  return age < 2 ? "INF" : age < 12 ? "CHD" : "ADT";
}
export const PAX_LABEL = { ADT: "Adult", CHD: "Child", INF: "Infant (no seat)" } as const;

export type PaxSource = {
  full_name: string; title?: string | null; first_name?: string | null; middle_name?: string | null; last_name?: string | null;
  passport_surname?: string | null; passport_given_name?: string | null; gender?: string | null; dob?: string | null; passport_expiry?: string | null;
};

/** Name exactly as airlines want it: SURNAME/GIVEN NAMES TITLE, built from the passport name when we have it. */
export function iataName(p: PaxSource, type: "ADT" | "CHD" | "INF" | null) {
  const surname = (p.passport_surname || p.last_name || "").trim();
  const given = (p.passport_given_name || [p.first_name, p.middle_name].filter(Boolean).join(" ") || "").trim();
  const t = (p.title || "").replace(/\./g, "").toUpperCase();
  const male = p.gender === "Male", female = p.gender === "Female";
  const title = type === "CHD" || type === "INF"
    ? (male ? "MSTR" : female ? "MISS" : t)
    : (["MR", "MRS", "MS", "MISS", "DR"].includes(t) ? t : male ? "MR" : female ? "MS" : t);
  // single-name passports: airlines repeat the name, or use FNU; we leave a clear flag instead of guessing
  const name = surname ? `${surname}/${given || "FNU"}` : `${given}`;
  return { text: `${name}${title ? " " + title : ""}`.toUpperCase().replace(/\s+/g, " ").trim(), fromPassport: !!p.passport_surname, hasSurname: !!surname };
}

/** What the airline will ask for on an international flight that we don't have yet. */
export function missingForAirline(p: PaxSource, international: boolean): string[] {
  const out: string[] = [];
  if (!p.passport_surname && international) out.push("passport name");
  if (!p.dob) out.push("date of birth");
  if (international && !p.gender) out.push("gender");
  if (international && !p.passport_expiry) out.push("passport expiry");
  return out;
}


export const IATA_TRAVEL_CENTRE = "https://www.iatatravelcentre.com/";
