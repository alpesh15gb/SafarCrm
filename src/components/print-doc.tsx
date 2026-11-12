import Link from "next/link";
import { ArrowLeft, MessageCircle } from "lucide-react";
import { btnClass } from "@/components/ui";
import { PrintButton } from "@/app/(team)/reports/client";

export type Agency = {
  agency_name: string; agency_phone: string | null; agency_email: string | null; agency_address: string | null;
  agency_gstin?: string | null; agency_pan?: string | null; bank_details?: string | null; upi_id?: string | null;
};
/** Columns to select from `settings` for any printed document. */
export const AGENCY_COLS = "agency_name, agency_phone, agency_email, agency_address, agency_gstin, agency_pan, bank_details, upi_id";

/** A printable client document (estimate, invoice, receipt): toolbar on screen, clean A4 sheet on paper. */
export function PrintDoc({ back, wa, agency, title, meta, children, stamp }: {
  back: { href: string; label: string }; wa?: string; agency: Agency; title: string; meta: [string, string][]; children: React.ReactNode;
  /** printed across the sheet, e.g. "Cancelled" */
  stamp?: string;
}) {
  return (
    <div className="mx-auto max-w-[820px]">
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Link href={back.href} className={btnClass("secondary")}><ArrowLeft className="h-4 w-4" />{back.label}</Link>
        <span className="flex-1" />
        {wa && <a className={btnClass("secondary")} href={wa} target="_blank" rel="noreferrer"><MessageCircle className="h-4 w-4" />Send on WhatsApp</a>}
        <PrintButton />
      </div>
      <p className="no-print mb-3 text-xs text-muted">To send it as a PDF: press Print / PDF and choose “Save as PDF”, then attach the file on WhatsApp or email.</p>
      <article className="relative rounded-xl border border-line bg-white p-8 text-[14px] leading-relaxed text-ink shadow-soft print:border-0 print:p-0 print:shadow-none">
        {stamp && <div aria-hidden className="pointer-events-none absolute inset-0 flex items-center justify-center text-6xl font-bold uppercase tracking-widest text-red-600/15">{stamp}</div>}
        <header className="flex flex-col gap-4 border-b-2 border-ink pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="text-xl font-bold tracking-tight">{agency.agency_name}</div>
            {agency.agency_address && <div className="whitespace-pre-line text-[13px] text-muted">{agency.agency_address}</div>}
            <div className="text-[13px] text-muted">{[agency.agency_phone, agency.agency_email].filter(Boolean).join(" · ")}</div>
            {(agency.agency_gstin || agency.agency_pan) && (
              <div className="text-[13px] text-muted">{[agency.agency_gstin && `GSTIN ${agency.agency_gstin}`, agency.agency_pan && `PAN ${agency.agency_pan}`].filter(Boolean).join(" · ")}</div>
            )}
          </div>
          <div className="shrink-0 sm:text-right">
            <div className="text-lg font-semibold uppercase tracking-wide">{title}</div>
            {meta.map(([k, v]) => <div key={k} className="whitespace-nowrap text-[13px]"><span className="text-muted">{k}: </span><b className="font-mono">{v}</b></div>)}
          </div>
        </header>
        <div className="pt-5">{children}</div>
      </article>
    </div>
  );
}

/** How to pay: bank account and UPI from Settings. Nothing is shown when neither is filled in. */
export function PayTo({ agency }: { agency: Agency }) {
  if (!agency.bank_details && !agency.upi_id) return null;
  return (
    <div className="mt-6 rounded-lg border border-line px-4 py-3 text-[13px]">
      <div className="mb-1 font-semibold">How to pay</div>
      {agency.bank_details && <div className="whitespace-pre-line">{agency.bank_details}</div>}
      {agency.upi_id && <div>UPI: <b className="font-mono">{agency.upi_id}</b></div>}
    </div>
  );
}
