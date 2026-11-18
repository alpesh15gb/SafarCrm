// The message that goes with a file sent to the client (owner, 2026-11-18): one format for email and WhatsApp,
//   FLIGHT BOOKING CONFIRMATION · Dear <name>, · Your flight booking has been confirmed! · [BOOKING CONFIRMED]
//   · booking ref · 📎 Your e-ticket is attached · Thank you for booking with <agency> · Have a pleasant journey!
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

/** Label + value pairs under the greeting. The attached ticket carries the flight, hotel and traveller details, so
 *  the message only gives the booking reference (owner, 2026-11-18: no travellers, destination or travel dates),
 *  and a visa's valid-until date when it is known. */
function details(i: SendInput): [string, string][] {
  const out: [string, string][] = [];
  if (i.line?.service === "visa" && s(i.line.details?.valid_to)) out.push(["Visa valid until", fdate(s(i.line.details?.valid_to))]);
  out.push(["Booking ref", s(i.maxId)]);
  return out.filter(([, v]) => v.trim() !== "");
}

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function sendMessage(i: SendInput): SendMessage {
  const w = wording(i.kind, i.line);
  const rows = details(i);
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
    "",
    // owner, 2026-11-18: say it is automated, and where to ask instead
    `_This is an automated message. Please do not reply to it.${contact ? ` For any help, contact ${agency}: ${contact}._` : "_"}`,
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
<tr><td style="padding:22px 28px 22px 28px;"><div style="border-top:1px solid #eef0f3;padding-top:12px;font-size:12px;color:#6b7280;line-height:1.5;">
  This is an automated email. Please do not reply to it.${contact ? `<br>For any help, contact ${esc(agency)}: ${esc(contact)}` : ""}
</div></td></tr>
</table>
</td></tr></table></body></html>`;

  return { subject, whatsapp, html };
}
