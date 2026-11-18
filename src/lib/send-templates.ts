// The message that goes with a file sent to the client (owner, 2026-11-18): one format for email and WhatsApp,
//   FLIGHT BOOKING CONFIRMATION · Dear <name>, · Your flight booking has been confirmed! · [BOOKING CONFIRMED]
//   · the booking details · 📎 Your e-ticket is attached · Thank you for booking with <agency> · Have a pleasant journey!
// worded for the kind of booking. Pure functions: no database, easy to test.
import { fdate } from "./format.ts";

export type SendLine = { service: string; status: string; details: Record<string, unknown> | null; service_date: string | null; reference: string | null } | null;
export type SendInput = {
  kind: string;               // file kind: ticket, voucher, policy, visa, document, other
  line: SendLine;             // the booking the file is on, if any
  customer: string;           // who it is addressed to
  maxId: string | null;
  agency: { name: string; phone?: string | null; email?: string | null };
};
export type SendMessage = { subject: string; whatsapp: string; html: string };

type Wording = { title: string; lead: string; badge: string | null; doc: string; closing: string };

const s = (v: unknown) => (typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v));

function wording(kind: string, line: SendLine): Wording {
  const svc = line?.service ?? (kind === "ticket" ? "flight" : kind === "voucher" ? "hotel" : kind === "policy" ? "insurance" : kind === "visa" ? "visa" : "");
  const confirmed = line ? line.status === "confirmed" : ["ticket", "voucher", "policy"].includes(kind);
  const badge = confirmed ? "BOOKING CONFIRMED" : null;
  switch (svc) {
    case "flight": return { title: "Flight booking confirmation", lead: confirmed ? "Your flight booking has been confirmed!" : "Here are the details of your flight.", badge, doc: "e-ticket", closing: "Have a pleasant journey! ✈️" };
    case "hotel": return { title: "Hotel booking confirmation", lead: confirmed ? "Your hotel booking has been confirmed!" : "Here are the details of your hotel.", badge, doc: "hotel voucher", closing: "Have a wonderful stay! 🏨" };
    case "rail": return { title: "Train booking confirmation", lead: confirmed ? "Your train booking has been confirmed!" : "Here are the details of your train journey.", badge, doc: "ticket", closing: "Have a pleasant journey! 🚆" };
    case "bus": return { title: "Bus booking confirmation", lead: confirmed ? "Your bus booking has been confirmed!" : "Here are the details of your bus journey.", badge, doc: "ticket", closing: "Have a pleasant journey! 🚌" };
    case "insurance": return { title: "Travel insurance", lead: confirmed ? "Your travel insurance is in place!" : "Here are the details of your travel insurance.", badge: confirmed ? "POLICY ISSUED" : null, doc: "insurance policy", closing: "Have a safe trip! 🛡️" };
    case "visa": {
      const st = s(line?.details?.application_status);
      const approved = st === "Approved" || st === "Passport collected";
      return { title: approved ? "Visa approved" : "Visa", lead: approved ? "Good news: your visa has been approved!" : "Here is your visa document.", badge: approved ? "VISA APPROVED" : null, doc: approved ? "visa" : "visa document", closing: "Have a pleasant journey! ✈️" };
    }
    default: return { title: "Travel document", lead: "Here is your travel document.", badge: null, doc: "document", closing: "Have a pleasant journey! ✈️" };
  }
}

/** Label + value pairs for the booking: route, date, flight, PNR; hotel, check-in/out; policy number... */
function details(line: SendLine, maxId: string | null): [string, string][] {
  const d = line?.details ?? {};
  const out: [string, string][] = [];
  if (line?.service === "flight") {
    const sectors = Array.isArray(d.sectors) ? (d.sectors as Record<string, unknown>[]) : [];
    sectors.forEach((x, i) => {
      const flight = [s(x.airline), s(x.flight_no)].filter(Boolean).join(" ");
      const when = [fdate(s(x.date)), s(x.dep)].filter(Boolean).join(" ");
      out.push([sectors.length > 1 ? `Flight ${i + 1}` : "Flight", [`${s(x.from)} → ${s(x.to)}`, when, flight].filter(Boolean).join(" · ")]);
    });
    if (s(d.pnr) || line.reference) out.push(["PNR", s(d.pnr) || s(line.reference)]);
  } else if (line?.service === "hotel") {
    out.push(["Hotel", [s(d.hotel_name), s(d.city)].filter(Boolean).join(", ")]);
    out.push(["Check-in", fdate(s(d.check_in))], ["Check-out", fdate(s(d.check_out))]);
    out.push(["Confirmation no.", s(d.confirmation_no) || s(line.reference)]);
  } else if (line?.service === "rail" || line?.service === "bus") {
    out.push(["Journey", [`${s(d.from)} → ${s(d.to)}`, fdate(s(d.date))].filter(Boolean).join(" · ")]);
    out.push(["PNR", s(d.pnr) || s(line.reference)]);
  } else if (line?.service === "insurance") {
    out.push(["Insurer", [s(d.insurer), s(d.plan)].filter(Boolean).join(" · ")]);
    out.push(["Policy no.", s(d.policy_no) || s(line.reference)]);
    out.push(["Cover", [fdate(s(d.start_date)), fdate(s(d.end_date))].filter(Boolean).join(" → ")]);
  } else if (line?.service === "visa") {
    out.push(["Visa", [s(d.country), s(d.visa_type)].filter(Boolean).join(" · ")]);
    if (s(d.valid_to)) out.push(["Valid until", fdate(s(d.valid_to))]);
  }
  if (maxId) out.push(["Booking ref", maxId]);
  // drop rows left empty (e.g. a route with no airports, " → ")
  return out.filter(([, v]) => v.replace(/[\s→·,]/g, "") !== "");
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function sendMessage(i: SendInput): SendMessage {
  const w = wording(i.kind, i.line);
  const rows = details(i.line, i.maxId);
  const name = i.customer.trim() || "Customer";
  const agency = i.agency.name.trim() || "your travel agent";
  const contact = [i.agency.phone, i.agency.email].filter(Boolean).join(" · ");
  const subject = `${w.title}${i.maxId ? ` · ${i.maxId}` : ""} · ${agency}`;

  const whatsapp = [
    `*${w.title.toUpperCase()}*`,
    "",
    `Dear ${name},`,
    "",
    w.lead,
    ...(w.badge ? ["", `✅ *${w.badge}*`] : []),
    ...(rows.length ? ["", ...rows.map(([k, v]) => `${k}: *${v}*`)] : []),
    "",
    `📎 Your ${w.doc} is attached to this message.`,
    "",
    `Thank you for booking with ${agency}.`,
    w.closing,
    ...(contact ? ["", `${agency} · ${contact}`] : []),
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;color:#1f2430;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e3e6ea;">
<tr><td style="padding:22px 28px 6px 28px;">
  <div style="font-size:12px;letter-spacing:1.5px;color:#e5533d;font-weight:bold;text-transform:uppercase;">${esc(agency)}</div>
  <h1 style="margin:8px 0 0 0;font-size:20px;letter-spacing:0.5px;text-transform:uppercase;">${esc(w.title)}</h1>
</td></tr>
<tr><td style="padding:14px 28px 0 28px;font-size:15px;line-height:1.55;">
  <p style="margin:0 0 10px 0;">Dear ${esc(name)},</p>
  <p style="margin:0 0 14px 0;">${esc(w.lead)}</p>
  ${w.badge ? `<span style="display:inline-block;background:#e7f6ec;color:#17803d;border:1px solid #b7e2c4;border-radius:999px;padding:5px 12px;font-size:12px;font-weight:bold;letter-spacing:1px;">✓ ${esc(w.badge)}</span>` : ""}
</td></tr>
${rows.length ? `<tr><td style="padding:16px 28px 0 28px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3e6ea;border-radius:10px;font-size:14px;">
  ${rows.map(([k, v], n) => `<tr><td style="padding:9px 14px;color:#6b7280;width:38%;${n ? "border-top:1px solid #eef0f3;" : ""}">${esc(k)}</td><td style="padding:9px 14px;font-weight:bold;${n ? "border-top:1px solid #eef0f3;" : ""}">${esc(v)}</td></tr>`).join("")}
  </table>
</td></tr>` : ""}
<tr><td style="padding:16px 28px 0 28px;font-size:15px;line-height:1.55;">
  <p style="margin:0 0 14px 0;">📎 Your ${esc(w.doc)} is attached to this email.</p>
  <p style="margin:0;">Thank you for booking with ${esc(agency)}.</p>
  <p style="margin:4px 0 0 0;">${esc(w.closing)}</p>
</td></tr>
<tr><td style="padding:22px 28px 22px 28px;"><div style="border-top:1px solid #eef0f3;padding-top:12px;font-size:12px;color:#6b7280;">${esc(agency)}${contact ? ` · ${esc(contact)}` : ""}</div></td></tr>
</table>
</td></tr></table></body></html>`;

  return { subject, whatsapp, html };
}
