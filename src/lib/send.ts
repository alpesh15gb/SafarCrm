import "server-only";
// Sends a file to the client directly (owner, after a client visit, 2026-11-18): the PDF itself on WhatsApp and as
// an email attachment, in one click. Configured with server settings (deploy/.env.production):
//   WhatsApp, through a self-hosted Evolution API (https://doc.evolution-api.com):
//     EVOLUTION_API_URL=https://wa.example.com   EVOLUTION_API_KEY=...   EVOLUTION_INSTANCE=maxtravel
//   Email, through Brevo or Resend (HTTPS APIs, no SMTP library needed):
//     EMAIL_PROVIDER=brevo  EMAIL_API_KEY=...  EMAIL_FROM=tickets@maxtravel.us  EMAIL_FROM_NAME=Max Travel
//     (or EMAIL_PROVIDER=resend with the same three)
// Not configured → { ok:false, code:"not_configured" } and the screen falls back to sharing a link.
// Nothing here logs message bodies or file contents.

export type SendResult = { ok: true } | { ok: false; code: "not_configured" | "bad_recipient" | "failed"; message: string };

/** Indian mobile → 91XXXXXXXXXX; a number with another country code is kept as typed (digits only). */
export function waNumber(raw: string | null | undefined): string | null {
  const d = String(raw ?? "").replace(/\D/g, "").replace(/^0+/, "");
  if (d.length === 10 && /^[6-9]/.test(d)) return `91${d}`;
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}

export const whatsappConfigured = () => !!(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY && process.env.EVOLUTION_INSTANCE);
export const emailConfigured = () => !!(process.env.EMAIL_PROVIDER && process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<{ ok: boolean; status: number }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60_000);
  try {
    const r = await fetch(url, { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { ok: r.ok, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(t);
  }
}

export async function sendWhatsAppDocument(to: string, file: { bytes: Uint8Array; mime: string; name: string }, caption: string): Promise<SendResult> {
  if (!whatsappConfigured()) return { ok: false, code: "not_configured", message: "WhatsApp sending isn't set up on the server yet." };
  const number = waNumber(to);
  if (!number) return { ok: false, code: "bad_recipient", message: `“${to}” isn't a WhatsApp number. Check the client's mobile.` };
  const base = process.env.EVOLUTION_API_URL!.replace(/\/+$/, "");
  const r = await post(`${base}/message/sendMedia/${encodeURIComponent(process.env.EVOLUTION_INSTANCE!)}`, { apikey: process.env.EVOLUTION_API_KEY! }, {
    number, mediatype: file.mime.startsWith("image/") ? "image" : "document", mimetype: file.mime,
    caption, fileName: file.name, media: Buffer.from(file.bytes).toString("base64"),
  });
  if (r.ok) return { ok: true };
  return { ok: false, code: "failed", message: r.status === 0 ? "Couldn't reach the WhatsApp server." : r.status === 401 || r.status === 403 ? "The WhatsApp server refused the key. Check EVOLUTION_API_KEY." : r.status === 404 ? "The WhatsApp instance wasn't found, or the number isn't on WhatsApp." : "WhatsApp didn't accept the message. Is the office phone still connected?" };
}

export async function sendEmailWithAttachment(to: string, subject: string, html: string, file: { bytes: Uint8Array; name: string }): Promise<SendResult> {
  if (!emailConfigured()) return { ok: false, code: "not_configured", message: "Email sending isn't set up on the server yet." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) return { ok: false, code: "bad_recipient", message: `“${to}” isn't an email address.` };
  const provider = process.env.EMAIL_PROVIDER!.trim().toLowerCase();
  const key = process.env.EMAIL_API_KEY!, from = process.env.EMAIL_FROM!, fromName = process.env.EMAIL_FROM_NAME || "";
  const content = Buffer.from(file.bytes).toString("base64");
  const r = provider === "resend"
    ? await post("https://api.resend.com/emails", { authorization: `Bearer ${key}` }, {
        from: fromName ? `${fromName} <${from}>` : from, to: [to.trim()], subject, html, attachments: [{ filename: file.name, content }],
      })
    : await post("https://api.brevo.com/v3/smtp/email", { "api-key": key }, {
        sender: { email: from, ...(fromName ? { name: fromName } : {}) }, to: [{ email: to.trim() }], subject, htmlContent: html,
        attachment: [{ name: file.name, content }],
      });
  if (r.ok) return { ok: true };
  return { ok: false, code: "failed", message: r.status === 0 ? "Couldn't reach the email service." : r.status === 401 || r.status === 403 ? "The email service refused the key. Check EMAIL_API_KEY." : "The email service didn't accept the message. Check the sender address is verified." };
}
