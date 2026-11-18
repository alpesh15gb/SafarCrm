import Link from "next/link";
import { ArrowLeft, MessageCircle } from "lucide-react";
import { btnClass, cx } from "@/components/ui";
import { PrintButton } from "@/app/(team)/reports/client";
import { inr } from "@/lib/format";
import { imageDataUrl } from "@/lib/storage";

export type Agency = {
  agency_name: string; agency_phone: string | null; agency_email: string | null; agency_address: string | null;
  agency_gstin?: string | null; agency_pan?: string | null; bank_details?: string | null; upi_id?: string | null;
  logo_path?: string | null;
};
/** Columns to select from `settings` for any printed document. */
export const AGENCY_COLS = "agency_name, agency_phone, agency_email, agency_address, agency_gstin, agency_pan, bank_details, upi_id, logo_path";

/** One labelled value in a details grid; empty values are left out. */
export type DocField = [label: string, value: React.ReactNode];

/** SAC codes for a travel agent's services (GST): shown on a tax invoice next to each line. */
export const SAC: Record<string, string> = {
  flight: "998551", rail: "998551", bus: "998551",   // reservation services for transportation
  hotel: "998552",                                   // reservation services for accommodation
  visa: "998559", insurance: "998559", other: "998559", // other reservation services
};

/** A printable client document (estimate, invoice, receipt) laid out like a tax invoice: the title and the agency
 *  on top, a grid of the document's details, then the body. Toolbar on screen, clean A4 sheet on paper. */
export async function PrintDoc({ back, wa, agency, title, meta, children, stamp }: {
  back: { href: string; label: string }; wa?: string; agency: Agency; title: string;
  /** the document's details (number, date, ...): shown as a labelled grid under the header */
  meta: DocField[];
  children: React.ReactNode;
  /** printed across the sheet, e.g. "Cancelled" */
  stamp?: string;
}) {
  // the logo from Settings, embedded in the page so it prints and saves to PDF with no login or expiring link
  const logo = await imageDataUrl(agency.logo_path);
  const fields: DocField[] = [
    ...meta,
    ["GSTIN", agency.agency_gstin ? <span className="font-mono">{agency.agency_gstin}</span> : null],
    ["PAN", agency.agency_pan ? <span className="font-mono">{agency.agency_pan}</span> : null],
  ];
  return (
    <div className="mx-auto max-w-[820px]">
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Link href={back.href} className={btnClass("secondary")}><ArrowLeft className="h-4 w-4" />{back.label}</Link>
        <span className="flex-1" />
        {wa && <a className={btnClass("secondary")} href={wa} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4" />Send on WhatsApp</a>}
        <PrintButton />
      </div>
      <p className="no-print mb-3 text-xs text-muted">To send it as a PDF: press Print / PDF and choose “Save as PDF”, then attach the file on WhatsApp or email.</p>
      <article className="relative rounded-xl border border-line bg-white p-8 text-[13.5px] leading-relaxed text-ink shadow-soft print:border-0 print:p-0 print:shadow-none">
        {stamp && <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-6xl font-bold uppercase tracking-widest text-red-600/15">{stamp}</div>}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <h1 className="text-[26px] font-bold uppercase leading-none tracking-tight">{title}</h1>
          <div className="min-w-0 sm:max-w-[55%] sm:text-right">
            {/* eslint-disable-next-line @next/next/no-img-element -- an inline data: URL, nothing to optimise */}
            {logo && <img src={logo} alt={agency.agency_name} className="mb-2 max-h-16 max-w-[220px] object-contain sm:ml-auto" />}
            <div className="text-[15px] font-bold uppercase tracking-wide text-coral-dark">{agency.agency_name}</div>
            {agency.agency_address && <div className="whitespace-pre-line text-[12.5px]">{agency.agency_address}</div>}
            <div className="text-[12.5px] text-muted">{[agency.agency_phone, agency.agency_email].filter(Boolean).join(" · ")}</div>
          </div>
        </header>
        <FieldGrid fields={fields} className="mt-6" />
        <div className="pt-2">{children}</div>
      </article>
    </div>
  );
}

/** Labelled values in columns: a small grey label over each bold value. */
export function FieldGrid({ fields, cols = 3, className }: { fields: DocField[]; cols?: 2 | 3; className?: string }) {
  const shown = fields.filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (!shown.length) return null;
  return (
    <dl className={cx("grid grid-cols-2 gap-x-6 gap-y-3", cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2", className)}>
      {shown.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-[11.5px] text-muted">{k}</dt>
          <dd className="break-words font-semibold">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A dashed rule across the sheet, with an optional heading in the middle ("PAYMENT BREAKUP"). */
export function Rule({ label }: { label?: string }) {
  return (
    <div className="my-5 flex items-center gap-3 text-[11.5px] font-semibold uppercase tracking-[0.08em]">
      <span className="h-0 flex-1 border-t border-dashed border-gray-400" />
      {label && <span>{label}</span>}
      {label && <span className="h-0 flex-1 border-t border-dashed border-gray-400" />}
    </div>
  );
}

export type BreakupRow = { label: React.ReactNode; sub?: React.ReactNode; amount: number; tone?: "minus" | "muted"; code?: string };

/** The money in a rounded box: one row per service (with a small line under it), then the grand total. */
export function Breakup({ rows, total, totalLabel = "Grand total", showCode }: {
  rows: BreakupRow[]; total: number; totalLabel?: string;
  /** show the SAC column (a tax invoice) */
  showCode?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-gray-400">
      <table className="w-full text-[13.5px]">
        {showCode && (
          <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
            <th className="px-4 py-2 font-medium">Description</th><th className="px-2 py-2 font-medium">SAC</th><th className="px-4 py-2 text-right font-medium">Amount</th>
          </tr></thead>
        )}
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              <td className="px-4 py-2">
                <div className={cx("font-semibold", r.tone === "muted" && "font-normal text-muted")}>{r.label}</div>
                {r.sub && <div className="text-[12px] text-muted">{r.sub}</div>}
              </td>
              {showCode && <td className="px-2 py-2 font-mono text-[12px] text-muted">{r.code ?? ""}</td>}
              <td className={cx("whitespace-nowrap px-4 py-2 text-right font-semibold tabular", r.tone === "minus" && "text-red-600", r.tone === "muted" && "font-normal text-muted")}>
                {r.tone === "minus" ? `−${inr(Math.abs(r.amount))}` : inr(r.amount)}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-gray-400 text-[15px] font-bold">
            <td className="px-4 py-3" colSpan={showCode ? 2 : 1}>{totalLabel}</td>
            <td className="whitespace-nowrap px-4 py-3 text-right tabular">{inr(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Numbered terms under a dashed "TERMS & CONDITIONS" rule. */
export function Terms({ items }: { items: React.ReactNode[] }) {
  return (
    <>
      <Rule label="Terms & conditions" />
      <ol className="list-decimal space-y-1 pl-5 text-[12px] text-muted">{items.map((t, i) => <li key={i}>{t}</li>)}</ol>
    </>
  );
}

/** The signature corner: computer-generated note on the left, "For <agency> · Authorised signatory" on the right. */
export function SignOff({ agency, note }: { agency: Agency; note: string }) {
  return (
    <div className="mt-10 flex items-end justify-between gap-4 text-[12.5px]">
      <div className="text-muted">{note}</div>
      <div className="text-center">
        <div className="font-semibold">For {agency.agency_name}</div>
        <div className="mb-1 h-10 w-48 border-b border-ink" />
        <div className="text-muted">Authorised signatory</div>
      </div>
    </div>
  );
}

/** How to pay: bank account and UPI from Settings. Nothing is shown when neither is filled in. */
export function PayTo({ agency }: { agency: Agency }) {
  if (!agency.bank_details && !agency.upi_id) return null;
  return (
    <div className="mt-5 rounded-lg border border-dashed border-gray-400 px-4 py-3 text-[13px]">
      <div className="mb-1 font-semibold">How to pay</div>
      {agency.bank_details && <div className="whitespace-pre-line">{agency.bank_details}</div>}
      {agency.upi_id && <div>UPI: <b className="font-mono">{agency.upi_id}</b></div>}
    </div>
  );
}
