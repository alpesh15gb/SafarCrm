"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, Check, Info, Plus, RotateCw, Save, Trash2, X } from "lucide-react";
import { Badge, Button, Card, Field, cx } from "@/components/ui";
import { Dialog, useAction } from "@/components/client";
import { CasePicker, CustomerPicker, SupplierPicker } from "@/components/pickers";
import { CustomerInline } from "@/components/forms/customer-inline";
import { SupplierQuickForm } from "@/components/forms/supplier-quick";
import { TicketUploadDialog } from "@/components/ticket-upload";
import {
  bookingForCompare, confirmImport, flightLinesOnCase, personCandidates, probableDuplicates, rejectImport, retryImport, saveImportDraft, recentFlightSuppliers,
  type ConfirmPayload,
} from "@/actions/imports";
import { suggestCases } from "@/actions/tasks";
import { genderFromTitle, reviewIssues, splitIssuedName, tripDestination, tripType, type Draft, type DraftSegment, type Field as F } from "@/lib/imports/schema";
import { offsetLabel } from "@/lib/flight-time";
import { fdate, inr } from "@/lib/format";
import { amount, parseMoney } from "@/lib/money";

export type ImportRow = {
  id: string; status: string; channel: string; file_name: string; mime: string; pages: number | null;
  error_code: string | null; error_summary: string | null; draft: unknown; draft_version: number; extraction: unknown;
  provider: string | null; parser_version: string | null; schema_version: string | null; attempts: number;
  result: { case_id: string; max_id: string; booking_line_id: string } | null; reject_reason: string | null; created_at: string;
  case_id: string | null; customer_id: string | null; booking_line_id: string | null;
  case: { id: string; max_id: string; title: string; customer_id: string } | null;
  customer: { id: string; full_name: string; mobile: string; customer_type: string } | null;
};

type Picked = { id: string; label: string; sub?: string };
type Match = { kind: "existing"; id: string; label: string } | { kind: "new"; first_name: string; last_name: string; mobile: string; title: string; gender: string } | null;
const SEG_FIELDS: [keyof DraftSegment, string, string][] = [
  ["from", "From", "w-16 uppercase"], ["to", "To", "w-16 uppercase"], ["dep_date", "Departs", "w-36"], ["dep_time", "Time", "w-20"],
  ["arr_date", "Arrives", "w-36"], ["arr_time", "Time", "w-20"], ["airline", "Airline", "w-32"], ["flight_no", "Flight", "w-24 uppercase"],
  ["cabin", "Cabin", "w-24"], ["baggage", "Baggage", "w-24"],
];
const STAGES = [{ v: "enquiry", l: "Enquiry" }, { v: "quoted", l: "Quoted" }, { v: "confirmed", l: "Confirmed" }, { v: "booked", l: "Booked" }];

export function ReviewScreen({ row, initialDraft, isBoss, canSeeProfit, providerHint }: { row: ImportRow; initialDraft: Draft; isBoss: boolean; canSeeProfit: boolean; providerHint: string | null }) {
  const router = useRouter();
  const { run, pending } = useAction();
  const [draft, setDraft] = useState<Draft>(initialDraft);
  const [version, setVersion] = useState(row.draft_version);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<"source" | "review">("review");
  const [replace, setReplace] = useState(false);
  const [reject, setReject] = useState(false);
  const [why, setWhy] = useState("");
  const editable = ["needs_review", "failed", "received"].includes(row.status);
  const reading = row.status === "processing" || (row.status === "received" && !providerHint && row.draft === null);

  // refresh while the worker is reading, without touching anything typed
  useEffect(() => {
    if (!reading) return;
    const h = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(h);
  }, [reading, router]);
  // a refreshed page with a newer saved draft (worker finished, or someone else saved) replaces ours only if we have no edits
  useEffect(() => {
    if (!dirty && row.draft_version !== version) { setDraft((row.draft as Draft | null) ?? initialDraft); setVersion(row.draft_version); }
  }, [row.draft_version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const upd = (fn: (d: Draft) => void) => { setDraft((d) => { const n = structuredClone(d); fn(n); return n; }); setDirty(true); };
  // nothing is flagged while the ticket is still being read: empty fields then are not mistakes
  const issues = useMemo(() => (reading ? [] : reviewIssues(draft)), [draft, reading]);
  const issueAt = (path: string) => issues.filter((i) => i.path === path || i.path.startsWith(path + "."));

  const save = () => run(() => saveImportDraft(row.id, version, draft), { refresh: false, then: (r) => { if (r.data) setVersion(r.data.version); setDirty(false); } });

  const source = (
    <div className="h-[75vh] overflow-hidden rounded-xl border border-line bg-gray-50">
      {row.mime === "application/pdf"
        ? <iframe title="Original ticket" src={`/api/imports/${row.id}/source`} className="h-full w-full" />
        // eslint-disable-next-line @next/next/no-img-element
        : <img src={`/api/imports/${row.id}/source`} alt="Original ticket" className="h-full w-full object-contain" />}
    </div>
  );

  return (
    <div className="space-y-4">
      <StatusBar row={row} providerHint={providerHint} reading={reading} />
      {row.status === "confirmed" && row.result && (
        <Card>
          <p className="flex flex-wrap items-center gap-2 text-sm"><Check className="h-4 w-4 text-emerald-600" />Confirmed on <b className="font-mono">{row.result.max_id}</b>.
            <Link className="inline-flex items-center gap-1 link" href={`/cases/${row.result.case_id}?tab=bookings`}>Open the booking <ArrowRight className="h-3.5 w-3.5" /></Link></p>
        </Card>
      )}

      {/* mobile: Source and Review tabs; desktop: side by side */}
      <div role="tablist" aria-label="Ticket import" className="flex gap-1 rounded-[10px] bg-gray-200/60 p-0.5 lg:hidden">
        {(["source", "review"] as const).map((t) => (
          <button key={t} role="tab" id={`tab-${t}`} aria-selected={tab === t} aria-controls={`panel-${t}`} type="button" onClick={() => setTab(t)}
            className={cx("flex-1 rounded-lg px-3 py-1.5 text-[13px] font-medium", tab === t ? "bg-white shadow" : "text-muted")}>
            {t === "source" ? "Source" : `Review${issues.some((i) => i.blocking) ? " (needs fixes)" : ""}`}
          </button>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <section id="panel-source" role="tabpanel" aria-labelledby="tab-source" className={cx("min-w-0 lg:sticky lg:top-4 lg:block lg:self-start", tab === "source" ? "block" : "hidden")}>
          {source}
          <p className="mt-1 text-xs text-muted">{row.pages ? `${row.pages} page${row.pages === 1 ? "" : "s"} · ` : ""}Private file. <a className="link" href={`/api/imports/${row.id}/source?download=1`}>Download</a></p>
        </section>
        <section id="panel-review" role="tabpanel" aria-labelledby="tab-review" className={cx("min-w-0 space-y-4 lg:block", tab === "review" ? "block" : "hidden")}>
          {editable && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={pending || !dirty} onClick={save}><Save className="h-4 w-4" />{dirty ? "Save draft" : "Saved"}</Button>
              {["failed", "needs_review"].includes(row.status) && !providerHint && <Button disabled={pending} onClick={() => run(() => retryImport(row.id))}><RotateCw className="h-4 w-4" />Read again</Button>}
              <Button onClick={() => setReplace(true)}>Replace file</Button>
              <Button variant="danger" onClick={() => { setWhy(""); setReject(true); }}><Trash2 className="h-4 w-4" />Reject</Button>
              <span className="text-xs text-muted">Version {version}{dirty && " · unsaved changes"}</span>
            </div>
          )}
          {!reading && <Issues issues={issues} />}
          <DraftEditor draft={draft} upd={upd} readOnly={!editable} issueAt={issueAt} />
          {editable && <MatchAndConfirm row={row} draft={draft} version={version} dirty={dirty} isBoss={isBoss} canSeeProfit={canSeeProfit} saveFirst={async () => {
            const r = await saveImportDraft(row.id, version, draft);
            if (r.ok && r.data) { setVersion(r.data.version); setDirty(false); return r.data.version; }
            throw new Error(r.ok ? "Could not save" : r.error);
          }} />}
        </section>
      </div>

      <TicketUploadDialog open={replace} onClose={() => setReplace(false)} replaces={row.id} scope={{ case_id: row.case_id ?? undefined, customer_id: row.customer_id ?? undefined }} />
      <Dialog open={reject} onClose={() => setReject(false)} title="Reject this import?"
        footer={<><Button onClick={() => setReject(false)}>Keep it</Button>
          <Button variant="danger" disabled={pending || !why.trim()} onClick={() => run(() => rejectImport(row.id, why), { then: () => { setReject(false); router.push("/imports"); } })}>Reject</Button></>}>
        <p className="mb-3 text-[13px] text-muted">Nothing is deleted: the file and what was read stay on record, private.</p>
        <Field label="Reason" required><input className="field" autoFocus value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Not a ticket; wrong customer; already entered" /></Field>
      </Dialog>
    </div>
  );
}

function StatusBar({ row, providerHint, reading }: { row: ImportRow; providerHint: string | null; reading: boolean }) {
  if (reading) return <p role="status" className="rounded-lg bg-sky-50 px-3 py-2 text-[13px] text-sky-900">Reading the ticket… this page updates by itself. You can start typing below at any time.</p>;
  if (row.status === "failed") {
    return (
      <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
        <b>Not read automatically.</b> {row.error_summary ?? "Something went wrong."} Enter the details below from the original on the left; nothing is lost.
      </p>
    );
  }
  if (row.status === "received" && providerHint) return <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">{providerHint}</p>;
  if (row.status === "rejected" || row.status === "duplicate") return <p className="rounded-lg bg-gray-100 px-3 py-2 text-[13px]">Closed: {row.reject_reason}</p>;
  if (row.status === "needs_review") {
    return <p className="rounded-lg bg-gray-50 px-3 py-2 text-[13px] text-muted">
      {row.provider && row.provider !== "none" ? "Read automatically. Check every value against the original; highlighted fields need attention." : "Manual entry."} Nothing is saved to a case until you confirm.
    </p>;
  }
  return null;
}

function Issues({ issues }: { issues: ReturnType<typeof reviewIssues> }) {
  if (!issues.length) return <p className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-[13px] text-emerald-900"><Check className="h-4 w-4" />No problems found. Still compare against the original.</p>;
  return (
    <ul className="space-y-1" aria-label="Things to check">
      {issues.map((i, k) => (
        <li key={k} className={cx("flex items-start gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px]", i.tone === "red" ? "bg-red-50 text-red-800" : "bg-amber-50 text-amber-900")}>
          {i.tone === "red" ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />}{i.text}
        </li>
      ))}
    </ul>
  );
}

/** One editable value: highlighted when missing, uncertain or contradicted; shows where it came from and the original reading. */
function FieldInput({ f, onChange, label, className, readOnly, problem }: { f: F; onChange: (v: string) => void; label: string; className?: string; readOnly?: boolean; problem?: "red" | "amber" }) {
  const tone = problem ?? (f.flag === "uncertain" ? "amber" : undefined);
  const hint = [f.page ? `page ${f.page}` : "", f.evidence ? `“${f.evidence}”` : "", f.original !== undefined && f.original !== f.value ? `read as “${f.original}”` : "", f.note ?? ""].filter(Boolean).join(" · ");
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <input aria-label={label} title={hint || label} readOnly={readOnly} value={f.value} onChange={(e) => onChange(e.target.value)} aria-invalid={tone === "red"}
        className={cx("field !h-8 !px-2 text-[13px]", className, tone === "red" && "!border-red-400 !bg-red-50", tone === "amber" && "!border-amber-400 !bg-amber-50")} />
    </label>
  );
}

const setF = (fld: F, v: string) => {
  if (fld.original === undefined && fld.value !== v) fld.original = fld.value;   // keep what was read before the first correction
  fld.value = v;
  delete fld.flag;
};

function DraftEditor({ draft: d, upd, readOnly, issueAt }: { draft: Draft; upd: (fn: (d: Draft) => void) => void; readOnly: boolean; issueAt: (p: string) => { tone: "red" | "amber" }[] }) {
  const tone = (p: string) => { const l = issueAt(p); return l.some((x) => x.tone === "red") ? "red" as const : l.length ? "amber" as const : undefined; };
  const blankSeg = (key: string): DraftSegment => ({ key, from: { value: "" }, to: { value: "" }, dep_date: { value: "" }, dep_time: { value: "" }, arr_date: { value: "" }, arr_time: { value: "" }, airline: { value: "" }, flight_no: { value: "" }, cabin: { value: "" }, baggage: { value: "" }, fare_basis: { value: "" } });
  return (
    <div className="space-y-4">
      <Card title={`Flights (${d.segments.length}) · ${tripType(d)}`} pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead><tr className="text-left text-xs text-muted">{["#", ...SEG_FIELDS.map((x) => x[1]), ""].map((h, i) => <th key={i} className="px-1.5 py-1.5 font-medium">{h}</th>)}</tr></thead>
            <tbody>
              {d.segments.map((s, i) => (
                <tr key={s.key} className="border-t border-line align-top">
                  <td className="px-1.5 py-1.5 text-muted">{i + 1}{offsetLabel({ date: s.dep_date.value, arr_date: s.arr_date.value }) ? <sup className="ml-0.5 text-coral-dark">{offsetLabel({ date: s.dep_date.value, arr_date: s.arr_date.value })}</sup> : null}</td>
                  {SEG_FIELDS.map(([k, label, cls]) => (
                    <td key={k} className="px-1 py-1">
                      <FieldInput f={s[k] as F} label={`Flight ${i + 1} ${label}`} className={cls} readOnly={readOnly}
                        problem={tone(`segments.${i}.${k}`)}
                        onChange={(v) => upd((n) => setF(n.segments[i][k] as F, ["from", "to", "flight_no"].includes(k) ? v.toUpperCase() : v))} />
                    </td>
                  ))}
                  <td className="px-1 py-1">{!readOnly && <button type="button" aria-label={`Remove flight ${i + 1}`} className="p-1 text-muted hover:text-red-600" onClick={() => upd((n) => {
                    const key = n.segments[i].key;
                    n.segments.splice(i, 1);
                    n.passengers.forEach((p) => p.tickets.forEach((t) => { t.segments = t.segments.filter((x) => x !== key); }));
                  })}><X className="h-4 w-4" /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!readOnly && <div className="border-t border-line px-3 py-2"><Button size="sm" onClick={() => upd((n) => {
          const key = `s${Math.max(0, ...n.segments.map((x) => Number(x.key.slice(1)) || 0)) + 1}`;
          n.segments.push({ ...blankSeg(key), from: { value: n.segments.at(-1)?.to.value ?? "" } });
        })}><Plus className="h-3.5 w-3.5" />Add flight</Button>
          <span className="ml-2 text-xs text-muted">Dates as printed (YYYY-MM-DD). Leave the arrival date empty if the ticket doesn&apos;t show it.</span></div>}
      </Card>

      <Card title={`Passengers (${d.passengers.length})`} pad={false}>
        <ul className="divide-y divide-line">
          {d.passengers.map((p, i) => (
            <li key={p.key} className="space-y-2 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-56 flex-1"><FieldInput f={p.name_as_issued} label={`Passenger ${i + 1} name as issued`} readOnly={readOnly} className="font-mono" problem={tone(`passengers.${i}.name_as_issued`)}
                  onChange={(v) => upd((n) => setF(n.passengers[i].name_as_issued, v))} /></div>
                <div className="w-20"><FieldInput f={p.pax_type} label={`Passenger ${i + 1} type`} readOnly={readOnly} onChange={(v) => upd((n) => setF(n.passengers[i].pax_type, v.toUpperCase()))} /></div>
                {!readOnly && d.passengers.length > 1 && <button type="button" aria-label={`Remove passenger ${i + 1}`} className="p-1 text-muted hover:text-red-600" onClick={() => upd((n) => { n.passengers.splice(i, 1); })}><X className="h-4 w-4" /></button>}
              </div>
              {p.tickets.map((t, j) => (
                <div key={j} className="flex flex-wrap items-center gap-2 pl-3 text-[13px]">
                  <span className="text-xs text-muted">Ticket</span>
                  <div className="w-44"><FieldInput f={t.number} label={`Passenger ${i + 1} ticket ${j + 1}`} readOnly={readOnly} className="font-mono" problem={tone(`passengers.${i}.tickets.${j}`)}
                    onChange={(v) => upd((n) => setF(n.passengers[i].tickets[j].number, v))} /></div>
                  <span className="text-xs text-muted">covers</span>
                  {d.segments.map((s, k) => (
                    <label key={s.key} className="flex items-center gap-1 text-xs">
                      <input type="checkbox" disabled={readOnly} checked={t.segments.includes(s.key)} onChange={(e) => upd((n) => {
                        const tt = n.passengers[i].tickets[j];
                        tt.segments = e.target.checked ? [...tt.segments, s.key] : tt.segments.filter((x) => x !== s.key);
                      })} />{k + 1}
                    </label>
                  ))}
                  {!readOnly && <button type="button" aria-label="Remove ticket" className="p-1 text-muted hover:text-red-600" onClick={() => upd((n) => { n.passengers[i].tickets.splice(j, 1); })}><X className="h-3.5 w-3.5" /></button>}
                </div>
              ))}
              {(p.ff ?? []).map((ff, j) => (
                <div key={`ff${j}`} className="flex flex-wrap items-center gap-2 pl-3 text-[13px]">
                  <span className="text-xs text-muted">Frequent flyer</span>
                  <input className="field !h-8 w-24 !px-2 text-[13px] uppercase" aria-label={`Passenger ${i + 1} frequent flyer ${j + 1} airline`} placeholder="Airline" readOnly={readOnly} value={ff.airline}
                    onChange={(e) => upd((n) => { n.passengers[i].ff![j].airline = e.target.value.toUpperCase(); })} />
                  <input className="field !h-8 w-40 !px-2 font-mono text-[13px] uppercase" aria-label={`Passenger ${i + 1} frequent flyer ${j + 1} number`} placeholder="Number" readOnly={readOnly} value={ff.number}
                    onChange={(e) => upd((n) => {
                      const x = n.passengers[i].ff![j], al = x.airline.trim().toUpperCase();
                      let v = e.target.value.toUpperCase().replace(/\s+/g, "");
                      // "6E12345678" typed with airline 6E: the code belongs in the airline box, not twice
                      if (al && /^([A-Z][A-Z0-9]|\d[A-Z])$/.test(al) && v.startsWith(al) && v.length > al.length + 3) v = v.slice(al.length);
                      x.number = v;
                    })} />
                  {!readOnly && <button type="button" aria-label="Remove frequent flyer number" className="p-1 text-muted hover:text-red-600" onClick={() => upd((n) => { n.passengers[i].ff!.splice(j, 1); })}><X className="h-3.5 w-3.5" /></button>}
                </div>
              ))}
              {!readOnly && <div className="flex gap-3 pl-3">
                <button type="button" className="text-xs link" onClick={() => upd((n) => { n.passengers[i].tickets.push({ number: { value: "" }, segments: n.segments.map((s) => s.key) }); })}>+ ticket number</button>
                <button type="button" className="text-xs link" onClick={() => upd((n) => { n.passengers[i].ff = [...(n.passengers[i].ff ?? []), { airline: "", number: "" }]; })}>+ frequent flyer</button>
              </div>}
            </li>
          ))}
        </ul>
        {!readOnly && <div className="border-t border-line px-3 py-2"><Button size="sm" onClick={() => upd((n) => {
          n.passengers.push({ key: `p${Math.max(0, ...n.passengers.map((x) => Number(x.key.slice(1)) || 0)) + 1}`, name_as_issued: { value: "" }, pax_type: { value: "ADT" }, tickets: [{ number: { value: "" }, segments: n.segments.map((s) => s.key) }] });
        })}><Plus className="h-3.5 w-3.5" />Add passenger</Button></div>}
      </Card>

      <Card title="References">
        <div className="grid gap-3 sm:grid-cols-2">
          <RefList title="Airline PNR" hint="The airline's booking reference" items={d.airline_pnrs} readOnly={readOnly}
            onChange={(list) => upd((n) => { n.airline_pnrs = list; })} upper />
          <RefList title="Supplier / GDS references" hint="Agency, consolidator or GDS references (kept separate from the airline PNR)" items={d.supplier_refs} readOnly={readOnly}
            onChange={(list) => upd((n) => { n.supplier_refs = list; })} />
        </div>      </Card>

      <Card title="Amounts on the document" sub="Evidence only. These never become a selling price, cost, GST, commission, receipt or refund.">
        {d.amounts.length === 0 ? <p className="text-sm text-muted">None read.</p> : (
          <ul className="space-y-1 text-[13px]">
            {d.amounts.map((a, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2">
                <span className="min-w-32 text-muted">{a.label || "Amount"}</span>
                <span className="font-mono">{a.currency.value} {a.amount.value}</span>
                <Badge tone="grey">{a.scope === "document" ? "whole document" : a.scope === "passenger" ? `passenger ${(d.passengers.findIndex((p) => p.key === a.passenger_key) + 1) || "?"}` : "scope not stated"}</Badge>
                {a.amount.page ? <span className="text-xs text-muted">page {a.amount.page}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function RefList({ title, hint, items, onChange, readOnly, upper }: { title: string; hint: string; items: Draft["airline_pnrs"]; onChange: (l: Draft["airline_pnrs"]) => void; readOnly: boolean; upper?: boolean }) {
  return (
    <div>
      <div className="text-[13px] font-medium">{title}</div>
      <div className="mb-1 text-xs text-muted">{hint}</div>
      <div className="space-y-1">
        {items.map((r, i) => (
          <div key={i} className="flex items-center gap-1">
            <input className="field !h-8 font-mono text-[13px]" aria-label={`${title} ${i + 1}`} readOnly={readOnly} value={r.value}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, value: upper ? e.target.value.toUpperCase() : e.target.value } : x)))} />
            {r.kind && <span className="whitespace-nowrap text-xs text-muted">{r.kind}</span>}
            {!readOnly && <button type="button" aria-label="Remove" className="p-1 text-muted hover:text-red-600" onClick={() => onChange(items.filter((_, j) => j !== i))}><X className="h-3.5 w-3.5" /></button>}
          </div>
        ))}
        {!readOnly && <button type="button" className="text-xs link" onClick={() => onChange([...items, { value: "" }])}>+ add</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- matching and confirmation
function MatchAndConfirm({ row, draft, version, dirty, isBoss, canSeeProfit, saveFirst }: { row: ImportRow; draft: Draft; version: number; dirty: boolean; isBoss: boolean; canSeeProfit: boolean; saveFirst: () => Promise<number> }) {
  const router = useRouter();
  const { run, pending } = useAction();
  const [key] = useState(() => crypto.randomUUID());   // one confirmation per screen: retries and double clicks reuse it
  const hasTicketNo = draft.passengers.some((p) => p.tickets.some((t) => t.number.value.trim()));
  // The usual case is pre-filled: we booked it, the ticket is issued, a new MAX ID at "Booked", the first traveller pays,
  // a new booking. Staff change any of it under "More options".
  const [payer, setPayer] = useState<Picked | null>(row.customer ? { id: row.customer.id, label: row.customer.full_name } : null);
  const [payerMobile, setPayerMobile] = useState(row.customer?.mobile ?? "");
  const [payerPax, setPayerPax] = useState<number | null>(row.customer ? null : 0);
  const [caseMode, setCaseMode] = useState<"existing" | "new">(row.case ? "existing" : "new");
  const [kase, setKase] = useState<Picked | null>(row.case ? { id: row.case.id, label: row.case.max_id, sub: row.case.title } : null);
  const [suggest, setSuggest] = useState<Awaited<ReturnType<typeof suggestCases>>>([]);
  const [newTitle, setNewTitle] = useState("");
  const [stage, setStage] = useState("booked");
  const [stageTouched, setStageTouched] = useState(false);
  const [existingStage, setExistingStage] = useState("");
  const [lines, setLines] = useState<Awaited<ReturnType<typeof flightLinesOnCase>>>([]);
  const [bMode, setBMode] = useState<"new" | "update" | "reissue">(row.booking_line_id ? "update" : "new");
  const [lineId, setLineId] = useState(row.booking_line_id ?? "");
  const [compared, setCompared] = useState(false);
  const [bookedBy, setBookedBy] = useState<"agency" | "customer">("agency");
  // with a ticket number it is issued; without one, the reviewer says which (some airlines use the booking reference)
  const [lineStatus, setLineStatusRaw] = useState<"" | "pending" | "confirmed">(hasTicketNo ? "confirmed" : "");
  const [statusTouched, setStatusTouched] = useState(false);
  const setLineStatus = (v: "pending" | "confirmed") => { setStatusTouched(true); setLineStatusRaw(v); };
  // the ticket may still be reading when the screen opens: until someone chooses, follow what the ticket shows
  useEffect(() => { if (!statusTouched) setLineStatusRaw(hasTicketNo ? "confirmed" : ""); }, [hasTicketNo, statusTouched]);
  const [charge, setCharge] = useState({ amount: "", confirmed: false });
  const [matches, setMatches] = useState<Match[]>(() => draft.passengers.map(() => null));
  const [dups, setDups] = useState<Awaited<ReturnType<typeof probableDuplicates>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [dupReason, setDupReason] = useState("");
  const [newPayer, setNewPayer] = useState<string | null>(null);
  // set by the comparison once the booking is loaded: false when a reissue brings no new ticket number
  const [reissueHasNewTicket, setReissueHasNewTicket] = useState<boolean | null>(null);
  const [supplier, setSupplier] = useState<Picked | null>(null);
  const [supplierSugs, setSupplierSugs] = useState<Awaited<ReturnType<typeof recentFlightSuppliers>>>([]);
  const [price, setPrice] = useState({ cost: "", sale: "" });
  const [family, setFamily] = useState(true);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => { setMatches((m) => draft.passengers.map((_, i) => m[i] ?? null)); }, [draft.passengers.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (payerPax !== null && payerPax >= draft.passengers.length) setPayerPax(draft.passengers.length ? 0 : null); }, [draft.passengers.length, payerPax]);
  // tickets carry the agency's own name, so the supplier is never guessed: recent flight suppliers are offered as shortcuts
  useEffect(() => { recentFlightSuppliers().then(setSupplierSugs).catch(() => setSupplierSugs([])); }, []);
  // the paying traveller, once matched to someone on file, also has trips to check
  const payerPaxMatch = !payer && payerPax !== null ? matches[payerPax] : null;
  // a new paying traveller's mobile is the payer mobile the others are filled from
  const paxMobile = payerPaxMatch?.kind === "new" ? payerPaxMatch.mobile : null;
  useEffect(() => { if (paxMobile !== null) setPayerMobile(paxMobile); }, [paxMobile]);
  // other new travellers without their own mobile follow the payer's (families usually share one); a number typed
  // for them is kept
  const prevPayerMobile = useRef(payerMobile);
  useEffect(() => {
    const prev = prevPayerMobile.current;
    prevPayerMobile.current = payerMobile;
    setMatches((all) => all.map((x, i) => (x?.kind === "new" && !(payer === null && i === payerPax) && (!x.mobile.trim() || x.mobile === prev) ? { ...x, mobile: payerMobile } : x)));
  }, [payerMobile]); // eslint-disable-line react-hooks/exhaustive-deps
  const payerId = payer?.id ?? (payerPaxMatch?.kind === "existing" ? payerPaxMatch.id : null);
  useEffect(() => { if (payerId) suggestCases(payerId).then(setSuggest).catch(() => setSuggest([])); else setSuggest([]); }, [payerId]);
  useEffect(() => { if (caseMode === "existing" && kase) flightLinesOnCase(kase.id).then(setLines); else setLines([]); }, [caseMode, kase]);
  useEffect(() => { probableDuplicates(draft).then(setDups).catch(() => setDups([])); }, [row.id, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setCompared(false); }, [lineId, bMode]);
  // an itinerary that isn't ticketed yet makes a quoted MAX ID, unless the reviewer chose the stage
  useEffect(() => { if (!stageTouched) setStage(lineStatus === "pending" ? "quoted" : "booked"); }, [lineStatus, stageTouched]);

  const blocking = reviewIssues(draft).filter((i) => i.blocking);
  // a matching booking must be resolved: update it, or say why this is a separate trip (the database checks this too)
  const openDups = dups.filter((x) => x.status !== "cancelled" && !(bMode !== "new" && x.line_id === lineId));
  // supplier and prices: our own booking, entered as a new booking (an update or reissue keeps the booking's prices)
  const pricingShown = bookedBy === "agency" && bMode === "new";
  const payerName = payer ? payer.label : payerPax !== null ? (() => {
    const m = matches[payerPax];
    if (m?.kind === "existing") return m.label;
    if (m?.kind === "new") return `${m.first_name} ${m.last_name}`.trim() || `traveller ${payerPax + 1}`;
    const s = splitIssuedName(draft.passengers[payerPax]?.name_as_issued.value ?? "");
    return `${s.first} ${s.last}`.trim() || `traveller ${payerPax + 1}`;
  })() : "";
  const titleText = newTitle.trim() || `Flight ${draft.segments[0]?.from.value || ""} → ${tripDestination(draft)}`;
  const stageLabel = STAGES.find((s) => s.v === stage)?.l ?? stage;

  // what is still needed, in short words; the ones that live under More options open it
  const mainNeeds = [
    blocking.length && "fix the highlighted fields",
    openDups.length > 0 && !dupReason.trim() && "sort out the possible duplicate",
    !lineStatus && "say whether the ticket is issued",
    matches.some((m) => !m) && "choose who each traveller is",
    matches.some((m) => m?.kind === "new" && (!m.first_name.trim() || !m.mobile.trim())) && "a name and mobile for each new customer",
    pricingShown && canSeeProfit && price.sale.trim() && !price.cost.trim() && "the incoming price (0 if none)",
    pricingShown && [price.cost, price.sale].some((v) => v.trim() && parseMoney(v).kind === "invalid") && "prices as numbers",
  ];
  const moreNeeds = [
    caseMode === "new" && !payer && payerPax === null && "who pays",
    caseMode === "existing" && !kase && "which MAX ID",
    bMode !== "new" && !lineId && "the booking to update",
    bMode !== "new" && lineId && !compared && "tick that you compared the booking",
    bMode === "reissue" && lineId && reissueHasNewTicket === false && "a new ticket number for the reissue",
    bookedBy === "customer" && charge.confirmed && !charge.amount.trim() && "the agency charge",
  ];
  const missing = [...mainNeeds, ...moreNeeds].filter(Boolean) as string[];
  const showMore = moreOpen || moreNeeds.some(Boolean) || bMode !== "new";

  async function confirm() {
    setError(null);
    const payload: ConfirmPayload = {
      payer_customer_id: payer?.id ?? null,
      payer_passenger: payer ? null : payerPax,
      family: draft.passengers.length > 1 && family,
      pricing: pricingShown ? { supplier_id: supplier?.id ?? null, supplier_cost: canSeeProfit ? price.cost : "", selling_price: price.sale } : null,
      case: caseMode === "existing" ? { mode: "existing", id: kase!.id, stage: existingStage || null } : { mode: "new", title: newTitle, stage },
      booking: bMode === "new" ? { mode: "new" } : { mode: bMode, line_id: lineId, comparison_reviewed: compared },
      booked_by: bookedBy,
      line_status: lineStatus as "pending" | "confirmed",
      passengers: matches.map((m) => (m!.kind === "existing" ? { customer_id: m!.id } : { create: { first_name: m!.first_name, last_name: m!.last_name, mobile: m!.mobile, title: m!.title, gender: m!.gender } })),
      agency_charge: bookedBy === "customer" && charge.confirmed ? charge : null,
      duplicate_override_reason: openDups.length ? dupReason.trim() : null,
      // "issued" chosen for a document without a ticket number is the acknowledgment
      no_ticket_number_ack: lineStatus === "confirmed" && !hasTicketNo,
    };
    await run(async () => {
      const v = dirty ? await saveFirst() : version;
      return confirmImport(row.id, v, key, draft, payload);
    }, { then: (r) => { if (r.data) router.push(`/cases/${r.data.case_id}?tab=bookings`); } });
  }

  const radio = (checked: boolean, onChange: () => void, label: string, disabled = false) => (
    <label className={cx("flex items-center gap-1.5", disabled && "opacity-50")}><input type="radio" disabled={disabled} checked={checked} onChange={onChange} />{label}</label>
  );

  return (
    <Card title="Save this ticket" sub="Check the travellers, choose the supplier, type the prices, and confirm. Nothing is saved until you do.">
      <div className="space-y-5">
        {openDups.length > 0 && (
          <div role="alert" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900">
            <b>This ticket looks like a booking already in the CRM:</b>
            <ul className="list-disc pl-5">{openDups.map((x) => (
              <li key={x.line_id}><Link className="link" href={`/cases/${x.case_id}?tab=bookings`}>{x.max_id}</Link> {x.summary} {fdate(x.service_date)} ({x.reason}) {" "}
                <Button size="sm" variant="primary" onClick={() => { setCaseMode("existing"); setKase({ id: x.case_id, label: x.max_id }); setBMode("update"); setLineId(x.line_id); setDupReason(""); }}>Update that booking</Button></li>
            ))}</ul>
            <Field label="Or, if it really is a separate trip, say why">
              <input className="field" value={dupReason} onChange={(e) => setDupReason(e.target.value)} placeholder="Same PNR reused by the airline for a different journey" />
            </Field>
          </div>
        )}

        {/* 1. who travels */}
        <div>
          <div className="mb-1 text-[13px] font-medium">Travellers</div>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {draft.passengers.map((p, i) => (
              <PassengerMatch key={p.key} name={p.name_as_issued.value} ff={(p.ff ?? []).filter((x) => x.number.trim())} pays={!payer && payerPax === i}
                match={matches[i] ?? null} payerMobile={payerMobile} taken={matches.filter((_, j) => j !== i)}
                onChange={(m) => setMatches((all) => all.map((x, j) => (j === i ? m : x)))} />
            ))}
          </ul>
          {draft.passengers.length > 1 && (
            <label className="mt-2 flex items-start gap-2 text-[13px]">
              <input type="checkbox" className="mt-0.5" checked={family} onChange={(e) => setFamily(e.target.checked)} />
              <span>They are one family
                <span className="block text-xs text-muted">{payerName || "The first traveller"} becomes the head. Untick for colleagues or friends.</span>
              </span>
            </label>
          )}
        </div>

        {/* 2. no ticket number: the one question the ticket can't answer */}
        {!hasTicketNo && (
          <Field label="This document has no ticket number. Is the ticket issued?" required>
            <div className="flex flex-col gap-1 text-sm">
              {radio(lineStatus === "confirmed", () => setLineStatus("confirmed"), "Yes, it is issued (the airline uses the booking reference)")}
              {radio(lineStatus === "pending", () => setLineStatus("pending"), "No, it is only an itinerary")}
            </div>
          </Field>
        )}

        {/* 3. supplier and price */}
        {pricingShown && (
          <Pricing canSeeProfit={canSeeProfit} supplier={supplier} setSupplier={setSupplier} sugs={supplierSugs} price={price} setPrice={setPrice} />
        )}

        {/* a trip already on file for this client: one click instead of a second MAX ID */}
        {caseMode === "new" && suggest.length > 0 && (
          <div className="rounded-lg bg-sky-50 px-3 py-2 text-[13px] text-sky-900">
            {payerName} already has {suggest.length === 1 ? "a trip" : `${suggest.length} trips`}. Add this ticket to one of them?{" "}
            <span className="mt-1 flex flex-wrap gap-1.5">
              {suggest.map((s) => (
                <button key={s.id} type="button" className="rounded-full border border-sky-300 bg-white px-2 py-0.5 text-xs hover:bg-sky-100"
                  onClick={() => { setCaseMode("existing"); setKase({ id: s.id, label: s.max_id, sub: s.title }); }}><b className="font-mono">{s.max_id}</b> {s.title}</button>
              ))}
            </span>
          </div>
        )}

        {/* 4. what will happen, in one line; the rest under More options */}
        <div className="rounded-lg border border-line bg-gray-50 px-3 py-2.5 text-[13px]">
          <p>
            {caseMode === "new" ? <>A new MAX ID <b>“{titleText}”</b> at <b>{stageLabel}</b></> : kase ? <>Added to <b className="font-mono">{kase.label}</b></> : <>Added to an existing MAX ID</>}
            {caseMode === "new" && payerName && <>, paid by <b>{payerName}</b></>}
            {". "}{bMode === "new" ? (bookedBy === "agency" ? "Booked by us" : "Booked by the customer") : bMode === "update" ? "Updates a booking on it" : "Reissue of a booking on it"}
            {lineStatus === "confirmed" ? ", ticket issued." : lineStatus === "pending" ? ", itinerary only." : "."}
          </p>
          {!showMore && <button type="button" className="mt-1 text-xs link" onClick={() => setMoreOpen(true)}>More options: who pays, MAX ID, stage, update a booking, booked by the customer</button>}
          {showMore && (
            <div className="mt-3 space-y-4 border-t border-line pt-3">
              <div className="grid gap-3 sm:grid-cols-2">
                {caseMode === "new" && <Field label="Who pays" hint="The customer on the MAX ID. They don't have to travel.">
                  {!payer && payerPax !== null ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge tone="blue">Traveller {payerPax + 1}: {payerName}</Badge>
                      <button type="button" className="text-xs link" onClick={() => setPayerPax(null)}>someone else</button>
                    </div>
                  ) : newPayer !== null ? (
                    <CustomerInline initialName={newPayer} onCancel={() => setNewPayer(null)}
                      onCreated={(c) => { setPayer({ id: c.id, label: c.full_name }); setPayerMobile(c.mobile); setNewPayer(null); }} />
                  ) : (
                    <CustomerPicker value={payer} onChange={(o) => { setPayer(o ? { id: o.id, label: o.label } : null); setPayerMobile(o?.raw.mobile ?? ""); }}
                      footer={(q, close) => (
                        <button type="button" className="w-full rounded px-2 py-1.5 text-left text-sm link" onClick={() => { setNewPayer(q); close(); }}>
                          + New customer{q ? ` “${q}”` : ""}
                        </button>
                      )} />
                  )}
                  {!payer && payerPax === null && newPayer === null && draft.passengers.length > 0 && (
                    <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-muted">Or a traveller:</span>
                      {draft.passengers.map((p, i) => (
                        <button key={p.key} type="button" className="rounded-full border border-line px-2 py-0.5 hover:bg-gray-50" onClick={() => setPayerPax(i)}>
                          {splitIssuedName(p.name_as_issued.value).first || `Traveller ${i + 1}`} {splitIssuedName(p.name_as_issued.value).last}
                        </button>
                      ))}
                    </span>
                  )}
                </Field>}
                <Field label="MAX ID">
                  <span className="flex gap-3 text-sm">
                    {radio(caseMode === "new", () => { setCaseMode("new"); setBMode("new"); }, "New MAX ID")}
                    {radio(caseMode === "existing", () => setCaseMode("existing"), "Add to an existing one")}
                  </span>
                </Field>
              </div>

              {caseMode === "existing" ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Which MAX ID"><CasePicker value={kase} onChange={setKase} /></Field>
                  {kase && (
                    <Field label="Stage">
                      <select className="field" value={existingStage} onChange={(e) => setExistingStage(e.target.value)}>
                        <option value="">Leave it as it is</option>{STAGES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
                      </select>
                    </Field>
                  )}
                </div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Title"><input className="field" value={newTitle} placeholder={titleText} onChange={(e) => setNewTitle(e.target.value)} /></Field>
                  <Field label="Stage">
                    <select className="field" value={stage} onChange={(e) => { setStage(e.target.value); setStageTouched(true); }}>
                      {STAGES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
                    </select>
                  </Field>
                </div>
              )}

              {caseMode === "existing" && (
                <Field label="Booking">
                  <span className="flex flex-wrap gap-3 text-sm">
                    {radio(bMode === "new", () => setBMode("new"), "Add as a new booking")}
                    {radio(bMode === "update", () => setBMode("update"), "Update a booking already there")}
                    {radio(bMode === "reissue", () => setBMode("reissue"), "Reissue (new tickets replace old)")}
                  </span>
                  {bMode !== "new" && (
                    <select className="field mt-2" value={lineId} onChange={(e) => setLineId(e.target.value)}>
                      <option value="">Choose the flight booking…</option>
                      {lines.map((l) => <option key={l.id} value={l.id}>{l.summary ?? "Flight"} · {fdate(l.service_date) || "no date"} · {l.status}</option>)}
                    </select>
                  )}
                </Field>
              )}
              {bMode !== "new" && lineId && <Comparison lineId={lineId} draft={draft} compared={compared} setCompared={setCompared} reissue={bMode === "reissue"} onReissueCheck={setReissueHasNewTicket} />}
              {bMode !== "new" && <p className="text-xs text-muted">Updating a booking keeps its supplier and prices. Change them on the Bookings tab if needed.</p>}

              <div className="grid gap-3 sm:grid-cols-2">
                {bMode === "new" && (
                  <Field label="Who booked it?">
                    <span className="flex flex-col gap-1 text-sm">
                      {radio(bookedBy === "agency", () => setBookedBy("agency"), "We booked it")}
                      {radio(bookedBy === "customer", () => setBookedBy("customer"), "The customer booked it themselves")}
                    </span>
                  </Field>
                )}
                {hasTicketNo && (
                  <Field label="Ticket">
                    <span className="flex flex-col gap-1 text-sm">
                      {radio(lineStatus === "confirmed", () => setLineStatus("confirmed"), "Issued")}
                      {radio(lineStatus === "pending", () => setLineStatus("pending"), "Not issued yet (itinerary only)")}
                    </span>
                  </Field>
                )}
              </div>
              {bookedBy === "customer" && bMode === "new" && (
                <div className="rounded-lg border border-line bg-white p-3">
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={charge.confirmed} onChange={(e) => setCharge({ ...charge, confirmed: e.target.checked })} />
                    We charge the customer a service fee for it</label>
                  {charge.confirmed && <Field label="Service fee (₹)" className="mt-2"><input className="field tabular" inputMode="decimal" value={charge.amount} onChange={(e) => setCharge({ ...charge, amount: e.target.value })} /></Field>}
                  <p className="mt-1 text-xs text-muted">Only this fee is billed; the customer paid the airline themselves.</p>
                </div>
              )}
              {!moreNeeds.some(Boolean) && bMode === "new" && <button type="button" className="text-xs link" onClick={() => setMoreOpen(false)}>Hide options</button>}
            </div>
          )}
        </div>

        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-800">{error}</p>}
        {!isBoss && <p className="text-right text-xs text-muted">The ticket file stays private; the boss decides when the client sees it.</p>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {missing.length > 0 && <span id="confirm-needs" className="text-[13px] text-amber-800">Still needed: {missing.join(", ")}.</span>}
          <Button variant="primary" disabled={pending || missing.length > 0} aria-describedby={missing.length ? "confirm-needs" : undefined} onClick={confirm}><Check className="h-4 w-4" />Confirm and open booking</Button>
        </div>
      </div>
    </Card>
  );
}

function PassengerMatch({ name, ff, pays, match, onChange, payerMobile, taken }: { name: string; ff: { airline: string; number: string }[]; pays: boolean; match: Match; onChange: (m: Match) => void; payerMobile: string; taken: Match[] }) {
  const [cands, setCands] = useState<Awaited<ReturnType<typeof personCandidates>> | null>(null);
  const split = splitIssuedName(name);
  const asNew = (): Match => ({ kind: "new", first_name: split.first, last_name: split.last, mobile: payerMobile, title: split.title, gender: genderFromTitle(split.title) });
  useEffect(() => {
    if (name.trim().length < 2) { setCands([]); return; }
    const h = setTimeout(() => personCandidates(name).then((c) => {
      setCands(c);
      // nobody on file with a similar name: set them up as a new customer from the ticket (the reviewer can still change it)
      if (c.length === 0 && !match) onChange(asNew());
    }).catch(() => setCands([])), 300);
    return () => clearTimeout(h);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  const used = (id: string) => taken.some((t) => t?.kind === "existing" && t.id === id);
  return (
    <li className="space-y-2 px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-2"><span className="font-mono font-semibold">{name || "(no name yet)"}</span>
        {match?.kind === "existing" && <Badge tone="green">Matched: {match.label}</Badge>}
        {match?.kind === "new" && <Badge tone="blue">New customer</Badge>}
        {pays && <Badge tone="grey">Pays</Badge>}
        {match && <button type="button" className="text-xs link" onClick={() => onChange(null)}>change</button>}
      </div>
      {ff.length > 0 && (
        <p className="text-xs text-muted">Frequent flyer {ff.map((x) => `${x.airline} ${x.number}`.trim()).join(", ")}: {match?.kind === "existing" ? "added to their profile if it isn't there yet" : "saved on the profile"}.</p>
      )}
      {!match && (
        <div className="space-y-2">
          {cands === null ? <p className="text-xs text-muted">Looking for people on file…</p> : cands.length > 0 && (
            <ul className="space-y-1">
              {cands.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                  <span>{c.full_name}</span>
                  <span className="text-xs text-muted">{c.code}{c.dob && ` · born ${fdate(c.dob)}`}{c.passport_name && ` · passport ${c.passport_name}`}{c.family && ` · ${c.family} family`} · {c.why}</span>
                  <Button size="sm" disabled={used(c.id)} onClick={() => onChange({ kind: "existing", id: c.id, label: c.full_name })}>{used(c.id) ? "Already used" : "This person"}</Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted">Pick only if it is the same person (check date of birth or passport). A shared surname or phone number is not enough.</p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-56 flex-1"><CustomerPicker value={null} onChange={(o) => o && !used(o.id) && onChange({ kind: "existing", id: o.id, label: o.label })} /></div>
            <Button size="sm" onClick={() => onChange(asNew())}>New customer</Button>
          </div>
        </div>
      )}
      {match?.kind === "new" && (
        <div className="grid gap-2 sm:grid-cols-[6rem_1fr_1fr_1fr]">
          <Field label="Title">
            <select className="field" value={match.title} onChange={(e) => onChange({ ...match, title: e.target.value, gender: genderFromTitle(e.target.value) || match.gender })}>
              <option value=""></option>{["Mr", "Mrs", "Ms", "Miss", "Mstr", "Dr"].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
          <Field label="First name" required><input className="field" value={match.first_name} onChange={(e) => onChange({ ...match, first_name: e.target.value })} /></Field>
          <Field label="Last name"><input className="field" value={match.last_name} onChange={(e) => onChange({ ...match, last_name: e.target.value })} /></Field>
          <Field label="Mobile" required hint={!pays && payerMobile && match.mobile === payerMobile ? "Same as the payer's; change it if they have their own." : !match.mobile.trim() ? "Tickets show the agency's number; type the traveller's own." : undefined}>
            <input className="field" inputMode="tel" value={match.mobile} onChange={(e) => onChange({ ...match, mobile: e.target.value })} />
          </Field>
        </div>
      )}
    </li>
  );
}

/** Supplier, incoming price and client price for our own booking, with the profit or loss as you type.
 *  Staff who may not see profit enter only the supplier and the client price; the boss adds the cost later. */
function Pricing({ canSeeProfit, supplier, setSupplier, sugs, price, setPrice }: {
  canSeeProfit: boolean; supplier: Picked | null; setSupplier: (s: Picked | null) => void;
  sugs: { id: string; name: string }[]; price: { cost: string; sale: string }; setPrice: (p: { cost: string; sale: string }) => void;
}) {
  const [addSup, setAddSup] = useState<string | null>(null);
  const both = parseMoney(price.cost).kind === "value" && parseMoney(price.sale).kind === "value";
  const profit = amount(price.sale) - amount(price.cost);
  const bad = (v: string) => v.trim() !== "" && parseMoney(v).kind === "invalid";
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <div className="text-[13px] font-medium">Supplier and price</div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supplier" hint="Where you booked it. The ticket carries our name, so choose it yourself.">
          {addSup !== null ? (
            <div className="rounded-lg border border-dashed border-line p-3">
              <SupplierQuickForm initialName={addSup} onCreated={(s) => { setSupplier({ id: s.id, label: s.name }); setAddSup(null); }} />
              <button type="button" className="mt-2 text-xs link" onClick={() => setAddSup(null)}>Pick an existing supplier</button>
            </div>
          ) : (
            <SupplierPicker value={supplier} service="flight" onChange={(o) => setSupplier(o ? { id: o.id, label: o.label } : null)}
              footer={(q, close) => <button type="button" className="w-full rounded px-2 py-1.5 text-left text-sm link" onClick={() => { setAddSup(q); close(); }}>+ Quick add supplier{q ? ` “${q}”` : ""}</button>} />
          )}
          {!supplier && addSup === null && sugs.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-muted">Recent:</span>
              {sugs.map((s) => (
                <button key={s.id} type="button" className="rounded-full border border-line px-2 py-0.5 hover:bg-gray-50" onClick={() => setSupplier({ id: s.id, label: s.name })}>{s.name}</button>
              ))}
            </div>
          )}
        </Field>
        <div className={cx("grid gap-3", canSeeProfit ? "grid-cols-2" : "grid-cols-1")}>
          {canSeeProfit && (
            <Field label="Incoming (₹)" hint="What the supplier charges us">
              <input className={cx("field tabular", bad(price.cost) && "!border-red-400 !bg-red-50")} inputMode="decimal" value={price.cost} placeholder="0" onChange={(e) => setPrice({ ...price, cost: e.target.value })} />
            </Field>
          )}
          <Field label="Client price (₹)" hint="What the client pays">
            <input className={cx("field tabular", bad(price.sale) && "!border-red-400 !bg-red-50")} inputMode="decimal" value={price.sale} placeholder="0" onChange={(e) => setPrice({ ...price, sale: e.target.value })} />
          </Field>
        </div>
      </div>
      {canSeeProfit && both && (
        <p role="status" className={cx("rounded-lg px-3 py-2 text-sm font-medium tabular",
          profit > 0 ? "bg-emerald-50 text-emerald-900" : profit < 0 ? "bg-red-50 text-red-800" : "bg-gray-50 text-muted")}>
          {profit > 0 ? `Profit ${inr(profit)}` : profit < 0 ? `Loss ${inr(-profit)}` : "No profit, no loss"}
          {amount(price.sale) > 0 && profit !== 0 && Math.abs(profit) < amount(price.sale) * 10 ? <span className="ml-1 font-normal">({Math.round((profit / amount(price.sale)) * 1000) / 10}% of the client price)</span> : null}
        </p>
      )}
      {/* "48,50048,500" typed twice is still a number: say so when the two prices are far apart */}
      {both && amount(price.cost) > 0 && amount(price.sale) > 0 && Math.max(amount(price.cost), amount(price.sale)) > 3 * Math.min(amount(price.cost), amount(price.sale)) && (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          The two prices are very far apart ({inr(amount(price.cost))} and {inr(amount(price.sale))}). Check for a typo before confirming.
        </p>
      )}
      <p className="text-xs text-muted">
        {canSeeProfit ? "Typed by you, never read from the ticket. Leave both empty to price it later on the Bookings tab." : "The incoming price is added by the boss. Until then the booking shows as not fully priced."}
      </p>
    </div>
  );
}

/** Field-by-field: what the booking has now vs what the reviewed ticket says. Required before changing a booking that has data. */
const ticketKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

function Comparison({ lineId, draft, compared, setCompared, reissue, onReissueCheck }: { lineId: string; draft: Draft; compared: boolean; setCompared: (v: boolean) => void; reissue: boolean; onReissueCheck: (hasNew: boolean | null) => void }) {
  const [line, setLine] = useState<Awaited<ReturnType<typeof bookingForCompare>> | undefined>(undefined);
  useEffect(() => { setLine(undefined); bookingForCompare(lineId).then(setLine).catch(() => setLine(null)); }, [lineId]);
  const oldKeys = new Set((((line?.details.tickets as Record<string, string>[] | undefined) ?? [])).map((t) => ticketKey(t.number ?? "")));
  const freshTickets = draft.passengers.flatMap((p) => p.tickets.map((t) => t.number.value)).filter((n) => n.trim() && !oldKeys.has(ticketKey(n)));
  const hasNew = line ? freshTickets.length > 0 : null;
  useEffect(() => { onReissueCheck(hasNew); }, [hasNew]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onReissueCheck(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  const old = (line?.details.sectors as Record<string, string>[] | undefined) ?? [];
  const oldT = (line?.details.tickets as Record<string, string>[] | undefined) ?? [];
  const n = Math.max(old.length, draft.segments.length);
  const KEYS: [string, (s: DraftSegment) => string, string][] = [
    ["Route", (s) => `${s.from.value}→${s.to.value}`, "route"], ["Departs", (s) => `${s.dep_date.value} ${s.dep_time.value}`.trim(), "dep"],
    ["Arrives", (s) => `${s.arr_date.value} ${s.arr_time.value}`.trim(), "arr"], ["Flight", (s) => s.flight_no.value, "flight_no"],
  ];
  const oldVal = (s: Record<string, string> | undefined, k: string) => !s ? "" : k === "route" ? `${s.from}→${s.to}` : k === "dep" ? `${s.date ?? ""} ${s.dep ?? ""}`.trim() : k === "arr" ? `${s.arr_date ?? ""} ${s.arr ?? ""}`.trim() : s[k] ?? "";
  // an update that changes nothing (same flights, no new ticket number) needs no comparison tick
  const nothingDiffers = !!line && !reissue && freshTickets.length === 0
    && Array.from({ length: n }).every((_, i) => KEYS.every(([, get, k]) => oldVal(old[i], k) === (draft.segments[i] ? get(draft.segments[i]) : "")));
  useEffect(() => { if (nothingDiffers) setCompared(true); }, [nothingDiffers]); // eslint-disable-line react-hooks/exhaustive-deps
  if (line === undefined) return <p className="text-xs text-muted">Loading the booking…</p>;
  if (line === null) return <p role="alert" className="text-xs text-red-700">That booking could not be loaded.</p>;
  const newTickets = draft.passengers.flatMap((p) => p.tickets.map((t) => `${p.name_as_issued.value}: ${t.number.value}`));
  return (
    <div className="space-y-2 rounded-lg border border-line p-3 text-[13px]">
      <div className="font-medium">Compare before {reissue ? "reissuing" : "updating"} ({line.summary})</div>
      <table className="w-full">
        <thead><tr className="text-left text-xs text-muted"><th className="py-1">Flight</th><th>Field</th><th>Now</th><th>From the ticket</th></tr></thead>
        <tbody>
          {Array.from({ length: n }).flatMap((_, i) => KEYS.map(([label, get, k]) => {
            const a = oldVal(old[i], k), b = draft.segments[i] ? get(draft.segments[i]) : "";
            return <tr key={`${i}-${k}`} className={cx("border-t border-line", a !== b && "bg-amber-50")}><td className="py-1">{i + 1}</td><td>{label}</td><td className="font-mono">{a || "—"}</td><td className="font-mono">{b || "—"}</td></tr>;
          }))}
          <tr className="border-t border-line align-top"><td className="py-1" colSpan={2}>Tickets</td>
            <td className="font-mono text-xs">{oldT.map((t) => <div key={t.number}>{t.name_as_issued || t.passenger}: {t.number}</div>)}{oldT.length === 0 && "—"}</td>
            <td className="font-mono text-xs">{newTickets.map((t) => <div key={t}>{t}</div>)}</td></tr>
        </tbody>
      </table>
      {reissue && !hasNew && (
        <p role="alert" className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-800">No new ticket number on this document, so it isn&apos;t evidence of a reissue. Choose Update if the tickets are unchanged.</p>
      )}
      <p className="text-xs text-muted">{reissue ? "The old tickets and flights are kept in the booking's history. No new sale is created; prices stay as they are." : "Changed flights are kept in history. Prices stay as they are."}</p>
      {nothingDiffers
        ? <p className="flex items-center gap-1.5 text-xs text-emerald-800"><Check className="h-3.5 w-3.5" />The ticket matches this booking: nothing to compare.</p>
        : <label className="flex items-center gap-2"><input type="checkbox" checked={compared} onChange={(e) => setCompared(e.target.checked)} />I compared every highlighted difference with the original</label>}
    </div>
  );
}
