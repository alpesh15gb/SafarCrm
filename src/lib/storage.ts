import "server-only";
import { createAdmin } from "./supabase/server";

export const MAX_BYTES = 10 * 1024 * 1024;
const SIGS: [string, number[]][] = [
  ["application/pdf", [0x25, 0x50, 0x44, 0x46]],
  ["image/png", [0x89, 0x50, 0x4e, 0x47]],
  ["image/jpeg", [0xff, 0xd8, 0xff]],
];
export const EXT: Record<string, string> = { "application/pdf": "pdf", "image/png": "png", "image/jpeg": "jpg" };

/** Detects the real type from the first bytes; returns null if not PDF/JPG/PNG. */
export function sniff(buf: Uint8Array) {
  for (const [mime, sig] of SIGS) if (sig.every((b, i) => buf[i] === b)) return mime;
  return null;
}

export function slug(s: unknown) {
  return String(s ?? "").normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export async function streamFile(path: string, fileName: string, mime: string | null, download: boolean) {
  const { data, error } = await createAdmin().storage.from("files").download(path);
  if (error || !data) return new Response("File not found", { status: 404 });
  const safe = fileName.replace(/["\\\r\n]/g, "");
  return new Response(data.stream(), {
    headers: {
      "Content-Type": mime || data.type || "application/octet-stream",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
