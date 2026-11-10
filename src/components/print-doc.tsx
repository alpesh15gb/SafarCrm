import Link from "next/link";
import { ArrowLeft, MessageCircle } from "lucide-react";
import { btnClass } from "@/components/ui";
import { PrintButton } from "@/app/(team)/reports/client";

export type Agency = { agency_name: string; agency_phone: string | null; agency_email: string | null; agency_address: string | null };

/** A printable client document (receipt, quotation): toolbar on screen, clean A4 sheet on paper. */
export function PrintDoc({ back, wa, agency, title, meta, children }: {
  back: { href: string; label: string }; wa?: string; agency: Agency; title: string; meta: [string, string][]; children: React.ReactNode;
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
      <article className="rounded-xl border border-line bg-white p-8 text-[14px] leading-relaxed text-ink shadow-soft print:border-0 print:p-0 print:shadow-none">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-ink pb-4">
          <div>
            <div className="text-xl font-bold tracking-tight">{agency.agency_name}</div>
            {agency.agency_address && <div className="whitespace-pre-line text-[13px] text-muted">{agency.agency_address}</div>}
            <div className="text-[13px] text-muted">{[agency.agency_phone, agency.agency_email].filter(Boolean).join(" · ")}</div>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold uppercase tracking-wide">{title}</div>
            {meta.map(([k, v]) => <div key={k} className="text-[13px]"><span className="text-muted">{k}: </span><b className="font-mono">{v}</b></div>)}
          </div>
        </header>
        <div className="pt-5">{children}</div>
      </article>
    </div>
  );
}
