"use client";

import Link from "next/link";
import { useState } from "react";
import { CalendarDays, MapPin } from "lucide-react";
import { Avatar, LossDot, ServiceIcon, cx } from "@/components/ui";
import { useAction } from "@/components/client";
import { updateCase } from "@/actions/cases";
import { STATUS_LABEL } from "@/lib/constants";
import { fdate, inr, inrShort } from "@/lib/format";

export type BoardCase = {
  id: string; max_id: string; title: string; status: string; travel_start: string | null; destination: string | null;
  customer: string | null; staff: string | null; services: string[]; due: number; sale: number; loss: boolean;
};

const COLS = [
  { s: "enquiry", bar: "bg-gray-400" },
  { s: "quoted", bar: "bg-blue-500" },
  { s: "confirmed", bar: "bg-amber-500" },
  { s: "booked", bar: "bg-emerald-500" },
  { s: "completed", bar: "bg-emerald-700" },
];

/** Kanban of cases by stage. Drag a card to another column to change its status. */
export function CaseBoard({ cases: initial }: { cases: BoardCase[] }) {
  const [cases, setCases] = useState(initial);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const { run } = useAction();
  const [seen, setSeen] = useState(initial);
  if (seen !== initial) { setSeen(initial); setCases(initial); }

  function move(id: string, status: string) {
    const c = cases.find((x) => x.id === id);
    if (!c || c.status === status) return;
    const before = cases;
    setCases((xs) => xs.map((x) => (x.id === id ? { ...x, status } : x)));
    run(() => updateCase(id, { status }), { success: `${c.max_id} → ${STATUS_LABEL[status]}` }).then((ok) => { if (!ok) setCases(before); });
  }

  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-4 md:-mx-8 md:px-8">
      <div className="grid min-w-[1100px] grid-cols-5 gap-4">
        {COLS.map((col) => {
          const list = cases.filter((c) => c.status === col.s);
          const value = list.reduce((a, c) => a + c.sale, 0);
          return (
            <section
              key={col.s}
              onDragOver={(e) => { e.preventDefault(); setOver(col.s); }}
              onDragLeave={() => setOver((o) => (o === col.s ? null : o))}
              onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); setOver(null); setDrag(null); move(id, col.s); }}
              className={cx("flex min-h-[60vh] flex-col rounded-2xl bg-gray-100/70 p-2 ring-1 ring-inset transition-colors", over === col.s ? "bg-coral-soft ring-coral/40" : "ring-black/[0.03]")}
            >
              <header className="flex items-center gap-2 px-2 pb-2.5 pt-1.5">
                <span className={cx("h-2 w-2 rounded-full", col.bar)} />
                <h3 className="text-[13px] font-semibold">{STATUS_LABEL[col.s]}</h3>
                <span className="rounded-full bg-white px-1.5 text-[11px] font-semibold text-muted shadow-sm tabular">{list.length}</span>
                {value > 0 && <span className="ml-auto text-[11px] font-medium text-muted tabular">{inrShort(value)}</span>}
              </header>
              <div className="flex flex-1 flex-col gap-2">
                {list.map((c) => (
                  <article
                    key={c.id}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData("text/plain", c.id); e.dataTransfer.effectAllowed = "move"; setDrag(c.id); }}
                    onDragEnd={() => { setDrag(null); setOver(null); }}
                    className={cx("group relative cursor-grab rounded-xl border border-line bg-white p-3 shadow-soft transition-all hover:-translate-y-px hover:shadow-lift active:cursor-grabbing", drag === c.id && "rotate-1 opacity-50")}
                  >
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <Link href={`/cases/${c.id}`} className="inline-flex items-center gap-1.5 font-mono text-[12px] font-semibold text-gray-500 after:absolute after:inset-0 hover:text-coral-dark">
                        <LossDot show={c.loss} />{c.max_id}
                      </Link>
                      <span className="flex gap-1 text-gray-400">{c.services.map((s) => <ServiceIcon key={s} service={s} className="h-3.5 w-3.5" />)}</span>
                    </div>
                    <div className="line-clamp-2 text-[13.5px] font-medium leading-snug">{c.title}</div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-muted">
                      {c.travel_start && <span className="inline-flex items-center gap-1"><CalendarDays className="h-3 w-3" />{fdate(c.travel_start)}</span>}
                      {c.destination && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{c.destination}</span>}
                    </div>
                    <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-dashed border-line pt-2.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Avatar name={c.customer} size="xs" />
                        <span className="truncate text-xs">{c.customer}</span>
                      </span>
                      <span className="flex items-center gap-1.5">
                        {c.due > 0 && <span className="whitespace-nowrap rounded-full bg-amber-50 px-1.5 py-px text-[10.5px] font-semibold text-amber-700 tabular" title={`Due from client: ${inr(c.due)}`}>{inrShort(c.due)} due</span>}
                        {c.staff && <Avatar name={c.staff} size="xs" title={`Handled by ${c.staff}`} />}
                      </span>
                    </div>
                  </article>
                ))}
                {list.length === 0 && (
                  <div className="flex flex-1 items-start justify-center rounded-xl border border-dashed border-gray-300/80 px-3 py-6 text-center text-xs text-gray-400">
                    Drop a case here
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-muted">Drag a card to change its stage. To cancel a case, open it and choose Cancelled, so you can record a reason.</p>
    </div>
  );
}
