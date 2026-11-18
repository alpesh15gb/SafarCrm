import "server-only";
import nodemailer from "nodemailer";
// Sends a file to the client directly (owner, after a client visit, 2026-11-18): the PDF itself on WhatsApp and as
// an email attachment, in one click. Configured with server settings (deploy/.env.production):
//   WhatsApp, through a self-hosted Evolution API (https://doc.evolution-api.com):
//     EVOLUTION_API_URL=https://wa.example.com   EVOLUTION_API_KEY=...   EVOLUTION_INSTANCE=maxtravel
//   Email, through Brevo or Resend (HTTPS APIs, no SMTP library needed):
//     EMAIL_PROVIDER=brevo  EMAIL_API_KEY=...  EMAIL_FROM=tickets@maxtravel.us  EMAIL_FROM_NAME=Max Travel
//     (or EMAIL_PROVIDER=resend with the same three)
//   or through any SMTP server, e.g. the agency's Google Workspace (owner, 2026-11-18). The same settings the
//   agency already uses elsewhere:
//     SMTP_HOST=smtp-relay.gmail.com  SMTP_PORT=587  SMTP_SECURE=false  MAIL_FROM="Max Travel <cs@maxtravel.in>"
//     SMTP_USER / SMTP_PASSWORD: empty for the Workspace SMTP relay (it trusts the server's IP), or a login and an
//     app password for smtp.gmail.com.
//   (shortcut: EMAIL_PROVIDER=gmail  EMAIL_FROM=cs@maxtravel.in  EMAIL_API_KEY=<app password> = smtp.gmail.com:465)
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
// a value may arrive still wrapped in quotes from the env file, e.g. MAIL_FROM="Max Travel <cs@maxtravel.in>"
const env = (k: string) => (process.env[k] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
const smtpMode = () => !!env("SMTP_HOST") || env("EMAIL_PROVIDER").toLowerCase() === "gmail";
export const emailConfigured = () => smtpMode()
  ? !!(env("MAIL_FROM") || env("EMAIL_FROM"))
  : !!(env("EMAIL_PROVIDER") && env("EMAIL_API_KEY") && env("EMAIL_FROM"));

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
  if (smtpMode()) return sendSmtp(to.trim(), subject, html, file);
  const provider = env("EMAIL_PROVIDER").toLowerCase();
  const key = env("EMAIL_API_KEY"), from = env("EMAIL_FROM"), fromName = env("EMAIL_FROM_NAME");
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

/** Email over SMTP: Google Workspace SMTP relay, smtp.gmail.com with an app password, or any other mail server. */
async function sendSmtp(to: string, subject: string, html: string, file: { bytes: Uint8Array; name: string }): Promise<SendResult> {
  const gmailShortcut = !env("SMTP_HOST");
  const host = env("SMTP_HOST") || "smtp.gmail.com";
  const port = Number(env("SMTP_PORT") || (gmailShortcut ? 465 : 587));
  const secure = env("SMTP_SECURE") ? env("SMTP_SECURE").toLowerCase() === "true" : port === 465;
  const fromAddr = env("MAIL_FROM") || (env("EMAIL_FROM_NAME") ? `"${env("EMAIL_FROM_NAME").replace(/"/g, "")}" <${env("EMAIL_FROM")}>` : env("EMAIL_FROM"));
  const fromEmail = (fromAddr.match(/<([^>]+)>/)?.[1] ?? fromAddr).trim();
  const user = env("SMTP_USER") || (gmailShortcut ? fromEmail : "");
  const pass = (env("SMTP_PASSWORD") || env("EMAIL_API_KEY")).replace(/\s+/g, "");   // app passwords are shown with spaces
  const transport = nodemailer.createTransport({
    host, port, secure, requireTLS: !secure,
    // the Workspace relay checks the greeting name; the container's random hostname would not do
    name: env("SMTP_HELO") || fromEmail.split("@")[1] || undefined,
    ...(user ? { auth: { user, pass } } : {}),   // no login: the Workspace SMTP relay trusts the server's IP address
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
  });
  try {
    await transport.sendMail({ from: fromAddr, to, subject, html, attachments: [{ filename: file.name, content: Buffer.from(file.bytes) }] });
    return { ok: true };
  } catch (e) {
    const err = (e as { code?: string; responseCode?: number; response?: string }) ?? {};
    if (err.code === "EAUTH" || err.responseCode === 535) return { ok: false, code: "failed", message: `The mail server refused the login for ${user || "this server"}. Check SMTP_USER and SMTP_PASSWORD.` };
    if (err.responseCode === 550 && /relay|not allowed|denied/i.test(err.response ?? "")) {
      return { ok: false, code: "failed", message: "The Workspace SMTP relay refused this server. In Google Admin → Apps → Gmail → Routing → SMTP relay, allow this server's IP address." };
    }
    if (err.code === "ETIMEDOUT" || err.code === "ECONNECTION" || err.code === "ESOCKET" || err.code === "EDNS") return { ok: false, code: "failed", message: `Couldn't reach ${host}:${port} from the server.` };
    return { ok: false, code: "failed", message: "The mail server didn't accept the message. Try again, or check the address." };
  } finally {
    transport.close();
  }
}
