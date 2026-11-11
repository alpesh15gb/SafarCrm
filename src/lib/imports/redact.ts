// Masks personal identifiers in a ticket's text layer before it is sent to the extraction model (DPDP Rule 6:
// masking / data minimisation). The model only needs the booking facts; passport, Aadhaar, PAN, card numbers, dates of
// birth, mobile numbers and email addresses are never part of what it extracts, so they are replaced by labels.
//
// Careful not to touch what the review needs: 13-digit ticket numbers (with or without the 3-digit airline prefix and a
// hyphen), PNRs, flight numbers, airport codes, flight dates and times, and amounts.
//
// Scans and photos are sent as images and cannot be masked this way; only the text layer is covered.

export type Redaction = { text: string; counts: Record<string, number> };

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

export function redactForModel(input: string): Redaction {
  const counts: Record<string, number> = {};
  const hit = (k: string) => { counts[k] = (counts[k] ?? 0) + 1; };
  let t = input;

  // email addresses
  t = t.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, () => { hit("email"); return "[email]"; });

  // card numbers: 15–16 digits in groups, Luhn-valid. Ticket numbers are 13 digits, so they never match.
  t = t.replace(/(?<![\d-])(?:\d{4}[ -]?){3}\d{3,4}(?![\d-])/g, (m) => {
    const d = m.replace(/\D/g, "");
    if ((d.length === 15 || d.length === 16) && luhn(d)) { hit("card"); return `[card ending ${d.slice(-4)}]`; }
    return m;
  });

  // Aadhaar: 12 digits printed 4-4-4
  t = t.replace(/(?<![\d-])\d{4}[ ]\d{4}[ ]\d{4}(?![\d-])/g, () => { hit("aadhaar"); return "[aadhaar]"; });

  // PAN: AAAAA9999A
  t = t.replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, () => { hit("pan"); return "[pan]"; });

  // passport numbers: only next to a passport label or inside an airline DOCS line (P/IND/K1234567/...),
  // so booking references that happen to look similar are left alone
  t = t.replace(/\b(passport(?:\s*(?:no|number|#))?\.?|ppt(?:\s*no)?\.?)(\s*[:\-]?\s*)([A-Z]{1,2}\s?\d{6,8})\b/gi, (_m, label, sep) => {
    hit("passport"); return `${label}${sep}[passport]`;
  });
  t = t.replace(/\bP\/([A-Z]{3})\/([A-Z0-9]{6,9})\//g, (_m, country) => { hit("passport"); return `P/${country}/[passport]/`; });

  // dates of birth: only after a birth label; flight dates are left alone
  t = t.replace(/\b(d\.?o\.?b\.?|date of birth|birth ?date|born)(\s*[:\-]?\s*)(\d{1,2}[\s./-][A-Z0-9]{1,9}[\s./-]\d{2,4}|\d{4}-\d{2}-\d{2})/gi, (_m, label, sep) => {
    hit("dob"); return `${label}${sep}[date of birth]`;
  });

  // Indian mobile numbers: 10 digits from 6–9, optional +91 / 0. Not when glued to other digits or a hyphenated
  // ticket prefix (098-9876543210 stays a ticket number).
  t = t.replace(/(?<![\d-])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s]?\d{5}(?![\d-])/g, () => { hit("mobile"); return "[mobile]"; });

  return { text: t, counts };
}
