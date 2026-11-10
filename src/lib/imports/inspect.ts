// Checks an uploaded ticket before anything else touches it: real type (from its bytes), size, pages, password
// protection, damage, and whether a PDF has a readable text layer. Server-only (uses node:zlib).
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;   // 10 MB
export const IMPORT_MAX_PAGES = 10;
export const IMPORT_MAX_PIXELS = 40_000_000;         // e.g. 8000 × 5000

export type Inspection =
  | { ok: true; mime: "application/pdf" | "image/jpeg" | "image/png"; pages: number; sha256: string; text: string | null }
  | { ok: false; code: "too_large" | "unsupported" | "encrypted" | "corrupt" | "too_many_pages" | "image_too_large" | "empty"; message: string };

const latin1 = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");

export function sha256(buf: Uint8Array) {
  return createHash("sha256").update(buf).digest("hex");
}

export function inspect(buf: Uint8Array): Inspection {
  if (!buf.length) return { ok: false, code: "empty", message: "The file is empty." };
  if (buf.length > IMPORT_MAX_BYTES) return { ok: false, code: "too_large", message: "Files must be 10 MB or smaller." };
  const hash = sha256(buf);
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return inspectPdf(buf, hash);
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    // PNG: IHDR width/height are bytes 16–23
    if (buf.length < 24 || latin1(buf.subarray(12, 16)) !== "IHDR") return { ok: false, code: "corrupt", message: "This PNG looks damaged. Try saving or scanning it again." };
    const w = Buffer.from(buf.subarray(16, 20)).readUInt32BE(0), h = Buffer.from(buf.subarray(20, 24)).readUInt32BE(0);
    if (!w || !h) return { ok: false, code: "corrupt", message: "This PNG looks damaged." };
    if (w * h > IMPORT_MAX_PIXELS) return { ok: false, code: "image_too_large", message: "This image is very large. Please send a smaller photo or a PDF." };
    return { ok: true, mime: "image/png", pages: 1, sha256: hash, text: null };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    // JPEG must end with the end-of-image marker; a cut-off upload doesn't
    const tail = buf.subarray(Math.max(0, buf.length - 64));
    let eoi = false;
    for (let i = 0; i < tail.length - 1; i++) if (tail[i] === 0xff && tail[i + 1] === 0xd9) eoi = true;
    if (!eoi) return { ok: false, code: "corrupt", message: "This photo seems cut off or damaged. Please send it again." };
    return { ok: true, mime: "image/jpeg", pages: 1, sha256: hash, text: null };
  }
  return { ok: false, code: "unsupported", message: "Only PDF, JPG or PNG files can be imported. Other files (Word, HEIC, ZIP…) can't be read here." };
}

function inspectPdf(buf: Uint8Array, hash: string): Inspection {
  const s = latin1(buf);
  if (!/%%EOF\s*$/.test(s.slice(-2048))) return { ok: false, code: "corrupt", message: "This PDF is incomplete or damaged. Download it again from the airline or supplier and re-upload." };
  if (/\/Encrypt\s/.test(s) || /\/Encrypt\s*\d+\s+\d+\s+R/.test(s)) {
    return { ok: false, code: "encrypted", message: "This PDF is password-protected. Open it, save a copy without the password (or print to PDF), and upload that. You can also enter the booking by hand." };
  }
  const pages = (s.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  if (pages === 0) return { ok: false, code: "corrupt", message: "This PDF has no readable pages." };
  if (pages > IMPORT_MAX_PAGES) return { ok: false, code: "too_many_pages", message: `This PDF has ${pages} pages; the limit is ${IMPORT_MAX_PAGES}. Upload only the ticket pages.` };
  return { ok: true, mime: "application/pdf", pages, sha256: hash, text: pdfText(buf, s) };
}

/** Best-effort text layer: decompress content streams and collect the strings drawn with Tj/TJ.
 *  Returns null when there is too little readable text (a scan, or fonts we can't map); the caller then uses OCR. */
export function pdfText(buf: Uint8Array, s = latin1(buf)): string | null {
  const parts: string[] = [];
  const re = /<<([\s\S]{0,2000}?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  let total = 0;
  while ((m = re.exec(s)) && total < 400_000) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const dict = m[1];
    if (/\/Subtype\s*\/Image|\/Type\s*\/XObject|\/Length1/.test(dict)) { re.lastIndex = end; continue; }   // images, fonts
    let raw: Buffer = Buffer.from(buf.subarray(start, end));
    if (/\/FlateDecode/.test(dict)) {
      try { raw = inflateSync(raw); } catch { re.lastIndex = end; continue; }
    } else if (/\/Filter/.test(dict)) { re.lastIndex = end; continue; }   // other filters: not handled
    const text = drawnText(raw.toString("latin1"));
    if (text) { parts.push(text); total += text.length; }
    re.lastIndex = end;
  }
  const out = parts.join("\n").replace(/[ \t]+/g, " ").trim();
  // enough letters and digits to be a real text layer (not just page numbers)
  return (out.match(/[A-Za-z0-9]/g) ?? []).length >= 150 ? out.slice(0, 60_000) : null;
}

function drawnText(content: string): string {
  if (!/\bT[Jj]\b/.test(content)) return "";
  const lines: string[] = [];
  let line = "";
  const tok = /\((?:\\.|[^\\)])*\)\s*Tj|\[(?:\\.|[^\]])*\]\s*TJ|\bT\*|\bTd\b|\bTD\b|\bET\b|'|"/g;
  let m: RegExpExecArray | null;
  while ((m = tok.exec(content))) {
    const t = m[0];
    if (t.endsWith("Tj")) line += unescape(t.slice(1, t.lastIndexOf(")")));
    else if (t.endsWith("TJ")) {
      for (const sm of t.matchAll(/\((?:\\.|[^\\)])*\)|-?\d+(?:\.\d+)?/g)) {
        if (sm[0].startsWith("(")) line += unescape(sm[0].slice(1, -1));
        else if (Number(sm[0]) < -200) line += " ";   // a big kern is a word gap
      }
    } else { if (line.trim()) lines.push(line); line = ""; }
  }
  if (line.trim()) lines.push(line);
  return lines.join("\n");
}

function unescape(x: string) {
  return x.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) => {
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: "\n", r: "", t: " ", b: "", f: "", "(": "(", ")": ")", "\\": "\\" } as Record<string, string>)[e] ?? "";
  });
}
