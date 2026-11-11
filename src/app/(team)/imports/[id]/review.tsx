"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, ArrowRight, Check, Info, Plus, RotateCw, Save, Trash2, X } from "lucide-react";
import { Badge, Button, Card, Field, cx } from "@/components/ui";
import { Dialog, useAction } from "@/components/client";
import { CasePicker, CustomerPicker } from "@/components/pickers";
import { CustomerInline } from "@/components/forms/customer-inline";
import { TicketUploadDialog } from "@/components/ticket-upload";
import {
  bookingForCompare, confirmImport, flightLinesOnCase, personCandidates, probableDuplicates, rejectImport, retryImport, saveImportDraft,
  type ConfirmPayload,
} from "@/actions/imports";
import { suggestCases } from "@/actions/tasks";
import { reviewIssues, splitIssuedName, tripType, type Draft, type DraftSegment, type Field as F } from "@/lib/imports/schema";
import { offsetLabel } from "@/lib/flight-time";
import { fdate } from "@/lib/format";

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
type Match = { kind: "existing"; id: string; label: string } | { kind: "new"; first_name: string; last_name: string; mobile: string } | null;
const SEG_FIELDS: [keyof DraftSegment, string, string][] = [
  ["from", "From", "w-16 uppercase"], ["to", "To", "w-16 uppercase"], ["dep_date", "Departs", "w-36"], ["dep_time", "Time", "w-20"],
  ["arr_date", "Arrives", "w-36"], ["arr_time", "Time", "w-20"], ["airline", "Airline", "w-32"], ["flight_no", "Flight", "w-24 uppercase"],
  ["cabin", "Cabin", "w-24"], ["baggage", "Baggage", "w-24"],
];
const STAGES = [{ v: "enquiry", l: "Enquiry" }, { v: "quoted", l: "Quoted" }, { v: "confirmed", l: "Confirmed" }, { v: "booked", l: "Booked" }];

export function ReviewScreen({ row, initialDraft, isBoss, providerHint }: { row: ImportRow; initialDraft: Draft; isBoss: boolean; providerHint: string | null }) {
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
  const issues = useMemo(() => reviewIssues(draft), [draft]);
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
        <section id="panel-source" role="tabpanel" aria-labelledby="tab-source" className={cx("lg:sticky lg:top-4 lg:block lg:self-start", tab === "source" ? "block" : "hidden")}>
          {source}
          <p className="mt-1 text-xs text-muted">{row.pages ? `${row.pages} page${row.pages === 1 ? "" : "s"} · ` : ""}Private file. <a className="link" href={`/api/imports/${row.id}/source?download=1`}>Download</a></p>
        </section>
        <section id="panel-review" role="tabpanel" aria-labelledby="tab-review" className={cx("space-y-4 lg:block", tab === "review" ? "block" : "hidden")}>
          {editable && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="primary" disabled={pending || !dirty} onClick={save}><Save className="h-4 w-4" />{dirty ? "Save draft" : "Saved"}</Button>
              {["failed", "needs_review"].includes(row.status) && !providerHint && <Button disabled={pending} onClick={() => run(() => retryImport(row.id))}><RotateCw className="h-4 w-4" />Read again</Button>}
              <Button onClick={() => setReplace(true)}>Replace file</Button>
              <Button variant="danger" onClick={() => { setWhy(""); setReject(true); }}><Trash2 className="h-4 w-4" />Reject</Button>
              <span className="text-xs text-muted">Version {version}{dirty && " · unsaved changes"}</span>
            </div>
          )}
          <Issues issues={issues} />
          <DraftEditor draft={draft} upd={upd} readOnly={!editable} issueAt={issueAt} />
          {editable && <MatchAndConfirm row={row} draft={draft} version={version} dirty={dirty} isBoss={isBoss} saveFirst={async () => {
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
              {!readOnly && <button type="button" className="ml-3 text-xs link" onClick={() => upd((n) => { n.passengers[i].tickets.push({ number: { value: "" }, segments: n.segments.map((s) => s.key) }); })}>+ ticket number</button>}
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
        </div>
      </Card>

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
function MatchAndConfirm({ row, draft, version, dirty, isBoss, saveFirst }: { row: ImportRow; draft: Draft; version: number; dirty: boolean; isBoss: boolean; saveFirst: () => Promise<number> }) {
  const router = useRouter();
  const { run, pending } = useAction();
  const [key] = useState(() => crypto.randomUUID());   // one confirmation per screen: retries and double clicks reuse it
  const [payer, setPayer] = useState<Picked | null>(row.customer ? { id: row.customer.id, label: row.customer.full_name } : null);
  const [payerMobile, setPayerMobile] = useState(row.customer?.mobile ?? "");
  const [caseMode, setCaseMode] = useState<"existing" | "new">(row.case ? "existing" : "new");
  const [kase, setKase] = useState<Picked | null>(row.case ? { id: row.case.id, label: row.case.max_id, sub: row.case.title } : null);
  const [suggest, setSuggest] = useState<Awaited<ReturnType<typeof suggestCases>>>([]);
  const [newTitle, setNewTitle] = useState("");
  const [stage, setStage] = useState("");
  const [existingStage, setExistingStage] = useState("");
  const [lines, setLines] = useState<Awaited<ReturnType<typeof flightLinesOnCase>>>([]);
  const [bMode, setBMode] = useState<"new" | "update" | "reissue">(row.booking_line_id ? "update" : "new");
  const [lineId, setLineId] = useState(row.booking_line_id ?? "");
  const [compared, setCompared] = useState(false);
  const [bookedBy, setBookedBy] = useState<"" | "agency" | "customer">("");
  const [lineStatus, setLineStatus] = useState<"" | "pending" | "confirmed">("");
  const [charge, setCharge] = useState({ amount: "", confirmed: false });
  const [matches, setMatches] = useState<Match[]>(() => draft.passengers.map(() => null));
  const [dups, setDups] = useState<Awaited<ReturnType<typeof probableDuplicates>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [dupReason, setDupReason] = useState("");
  const [noTicketAck, setNoTicketAck] = useState(false);
  const [newPayer, setNewPayer] = useState<string | null>(null);

  useEffect(() => { setMatches((m) => draft.passengers.map((_, i) => m[i] ?? null)); }, [draft.passengers.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (payer) suggestCases(payer.id).then(setSuggest); else setSuggest([]); }, [payer]);
  useEffect(() => { if (caseMode === "existing" && kase) flightLinesOnCase(kase.id).then(setLines); else setLines([]); }, [caseMode, kase]);
  useEffect(() => { probableDuplicates(draft).then(setDups).catch(() => setDups([])); }, [row.id, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setCompared(false); }, [lineId, bMode]);

  const blocking = reviewIssues(draft).filter((i) => i.blocking);
  // a matching booking must be resolved: update it, or say why this is a separate trip (the database checks this too)
  const openDups = dups.filter((x) => x.status !== "cancelled" && !(bMode !== "new" && x.line_id === lineId));
  const hasTicketNo = draft.passengers.some((p) => p.tickets.some((t) => t.number.value.trim()));
  const missing = [
    blocking.length && "fix the highlighted fields",
    openDups.length > 0 && !dupReason.trim() && "resolve the possible duplicate (use that booking, or give a reason)",
    lineStatus === "confirmed" && !hasTicketNo && !noTicketAck && "tick that the ticket is issued without a ticket number",
    caseMode === "new" && !payer && "who pays",
    caseMode === "existing" && !kase && "the MAX ID",
    caseMode === "new" && !stage && "the stage for the new MAX ID",
    bMode !== "new" && !lineId && "the booking to update",
    bMode !== "new" && lineId && !compared && "tick that you compared the booking",
    !bookedBy && "who booked it",
    !lineStatus && "the booking status",
    matches.some((m) => !m || (m.kind === "new" && (!m.first_name.trim() || !m.mobile.trim()))) && "match every passenger",
    bookedBy === "customer" && charge.confirmed && !charge.amount.trim() && "the agency charge",
  ].filter(Boolean) as string[];

  async function confirm() {
    setError(null);
    const payload: ConfirmPayload = {
      payer_customer_id: payer?.id ?? null,
      case: caseMode === "existing" ? { mode: "existing", id: kase!.id, stage: existingStage || null } : { mode: "new", title: newTitle, stage },
      booking: bMode === "new" ? { mode: "new" } : { mode: bMode, line_id: lineId, comparison_reviewed: compared },
      booked_by: bookedBy as "agency" | "customer",
      line_status: lineStatus as "pending" | "confirmed",
      passengers: matches.map((m) => (m!.kind === "existing" ? { customer_id: m!.id } : { create: { first_name: m!.first_name, last_name: m!.last_name, mobile: m!.mobile } })),
      agency_charge: bookedBy === "customer" && charge.confirmed ? charge : null,
      duplicate_override_reason: openDups.length ? dupReason.trim() : null,
      no_ticket_number_ack: lineStatus === "confirmed" && !hasTicketNo ? noTicketAck : false,
    };
    await run(async () => {
      const v = dirty ? await saveFirst() : version;
      return confirmImport(row.id, v, key, draft, payload);
    }, { then: (r) => { if (r.data) router.push(`/cases/${r.data.case_id}?tab=bookings`); } });
  }

  return (
    <Card title="Match and confirm" sub="Nothing is saved to a case until you confirm. Payer and travellers are matched separately.">
      <div className="space-y-5">
        {openDups.length > 0 && (
          <div role="alert" className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900">
            <b>This ticket matches a booking already in the CRM. Resolve it before confirming:</b>
            <ul className="list-disc pl-5">{openDups.map((x) => (
              <li key={x.line_id}><Link className="link" href={`/cases/${x.case_id}?tab=bookings`}>{x.max_id}</Link> {x.summary} {fdate(x.service_date)} ({x.reason}) {" "}
                <Button size="sm" variant="primary" onClick={() => { setCaseMode("existing"); setKase({ id: x.case_id, label: x.max_id }); setBMode("update"); setLineId(x.line_id); setDupReason(""); }}>Use this booking</Button></li>
            ))}</ul>
            <p className="text-xs">File: <span className="font-mono">{row.file_name}</span> · Ticket says: {draft.segments.map((s) => `${s.from.value}→${s.to.value} ${fdate(s.dep_date.value) || "?"}`).join(", ")} · PNR {draft.airline_pnrs.map((r) => r.value).join(", ") || "—"}</p>
            <Field label="Or, if it really is a separate trip, say why">
              <input className="field" value={dupReason} onChange={(e) => setDupReason(e.target.value)} placeholder="Same PNR reused by the airline for a different journey" />
            </Field>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Who pays (the customer on the MAX ID)" hint="Matched on its own: the payer doesn't have to travel.">
            {newPayer !== null ? (
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
          </Field>
          <Field label="MAX ID">
            <div className="flex gap-3 text-sm">
              <label className="flex items-center gap-1.5"><input type="radio" checked={caseMode === "existing"} onChange={() => setCaseMode("existing")} />Existing</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={caseMode === "new"} onChange={() => setCaseMode("new")} />New MAX ID</label>
            </div>
          </Field>
        </div>

        {caseMode === "existing" ? (
          <div className="space-y-2">
            <CasePicker value={kase} onChange={setKase} />
            {suggest.length > 0 && !kase && (
              <div className="flex flex-wrap gap-1.5 text-xs">
                <span className="text-muted">Trips for {payer?.label}:</span>
                {suggest.map((s) => <button key={s.id} type="button" className="rounded-full border border-line px-2 py-0.5 hover:bg-gray-50" onClick={() => setKase({ id: s.id, label: s.max_id, sub: s.title })}><b className="font-mono">{s.max_id}</b> {s.title}</button>)}
              </div>
            )}
            {kase && (
              <Field label="Change the stage?" hint="Only if the ticket shows it. The document is not proof of an earlier enquiry or quotation.">
                <select className="field" value={existingStage} onChange={(e) => setExistingStage(e.target.value)}>
                  <option value="">Leave the stage as it is</option>{STAGES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
                </select>
              </Field>
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {suggest.length > 0 && <p className="sm:col-span-2 rounded-lg bg-sky-50 px-3 py-2 text-[13px] text-sky-900">{payer?.label} already has {suggest.length} trip{suggest.length === 1 ? "" : "s"}. Check them under “Existing” before making another MAX ID.</p>}
            <Field label="Title"><input className="field" value={newTitle} placeholder={`Flight ${draft.segments[0]?.from.value || ""} → ${draft.segments.at(-1)?.to.value || ""}`} onChange={(e) => setNewTitle(e.target.value)} /></Field>
            <Field label="Stage" required hint="Choose it yourself; nothing is assumed from the ticket.">
              <select className="field" value={stage} onChange={(e) => setStage(e.target.value)}>
                <option value="">Choose…</option>{STAGES.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
              </select>
            </Field>
          </div>
        )}

        <Field label="Booking">
          <div className="flex flex-wrap gap-3 text-sm">
            <label className="flex items-center gap-1.5"><input type="radio" checked={bMode === "new"} onChange={() => setBMode("new")} />New booking</label>
            <label className={cx("flex items-center gap-1.5", caseMode !== "existing" && "opacity-50")}><input type="radio" disabled={caseMode !== "existing"} checked={bMode === "update"} onChange={() => setBMode("update")} />Update an existing booking</label>
            <label className={cx("flex items-center gap-1.5", caseMode !== "existing" && "opacity-50")}><input type="radio" disabled={caseMode !== "existing"} checked={bMode === "reissue"} onChange={() => setBMode("reissue")} />Reissue (new tickets replace old)</label>
          </div>
          {bMode !== "new" && caseMode === "existing" && (
            <select className="field mt-2" value={lineId} onChange={(e) => setLineId(e.target.value)}>
              <option value="">Choose the flight booking…</option>
              {lines.map((l) => <option key={l.id} value={l.id}>{l.summary ?? "Flight"} · {fdate(l.service_date) || "no date"} · {l.status}</option>)}
            </select>
          )}
        </Field>
        {bMode !== "new" && lineId && <Comparison lineId={lineId} draft={draft} compared={compared} setCompared={setCompared} reissue={bMode === "reissue"} />}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Who booked it?" required>
            <div className="flex flex-col gap-1 text-sm">
              <label className="flex items-center gap-1.5"><input type="radio" checked={bookedBy === "agency"} onChange={() => setBookedBy("agency")} />We (the agency) booked it</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={bookedBy === "customer"} onChange={() => setBookedBy("customer")} />The customer booked it directly</label>
            </div>
          </Field>
          <Field label="Booking status" required>
            <div className="flex flex-col gap-1 text-sm">
              <label className="flex items-center gap-1.5"><input type="radio" checked={lineStatus === "confirmed"} onChange={() => setLineStatus("confirmed")} />Confirmed (ticket issued)</label>
              <label className="flex items-center gap-1.5"><input type="radio" checked={lineStatus === "pending"} onChange={() => setLineStatus("pending")} />Pending (itinerary only, not ticketed)</label>
            </div>
            {lineStatus === "confirmed" && !hasTicketNo && (
              <label className="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 px-2.5 py-2 text-[13px] text-amber-900">
                <input type="checkbox" className="mt-0.5" checked={noTicketAck} onChange={(e) => setNoTicketAck(e.target.checked)} />
                The document shows no ticket number, but the ticket is issued (the airline uses the booking reference)
              </label>
            )}
          </Field>
        </div>
        {bookedBy === "customer" && (
          <div className="rounded-lg border border-line p-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={charge.confirmed} onChange={(e) => setCharge({ ...charge, confirmed: e.target.checked })} />
              We agreed a separate service charge with the customer</label>
            {charge.confirmed && <Field label="Agency charge (₹)" className="mt-2"><input className="field tabular" inputMode="decimal" value={charge.amount} onChange={(e) => setCharge({ ...charge, amount: e.target.value })} /></Field>}
            <p className="mt-1 text-xs text-muted">Only this charge is billed. The fare on the ticket is the customer&apos;s own purchase and is kept as evidence only.</p>
          </div>
        )}
        {bookedBy === "agency" && <p className="text-xs text-muted">Prices, supplier cost and commission are not taken from the ticket. The booking is marked “not priced” until someone enters them on the Bookings tab.</p>}

        <div>
          <div className="mb-1 text-[13px] font-medium">Travellers</div>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {draft.passengers.map((p, i) => (
              <PassengerMatch key={p.key} name={p.name_as_issued.value} match={matches[i] ?? null} payerMobile={payerMobile} taken={matches.filter((_, j) => j !== i)}
                onChange={(m) => setMatches((all) => all.map((x, j) => (j === i ? m : x)))} />
            ))}
          </ul>
        </div>

        {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-800">{error}</p>}
        {missing.length > 0 && <p className="text-[13px] text-muted">Still needed: {missing.join(", ")}.</p>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!isBoss && <span className="text-xs text-muted">The ticket file stays private; the boss decides when the client sees it.</span>}
          <Button variant="primary" disabled={pending || missing.length > 0} onClick={confirm}><Check className="h-4 w-4" />Confirm and open booking</Button>
        </div>
      </div>
    </Card>
  );
}

function PassengerMatch({ name, match, onChange, payerMobile, taken }: { name: string; match: Match; onChange: (m: Match) => void; payerMobile: string; taken: Match[] }) {
  const [cands, setCands] = useState<Awaited<ReturnType<typeof personCandidates>> | null>(null);
  useEffect(() => {
    if (name.trim().length < 2) { setCands([]); return; }
    const h = setTimeout(() => personCandidates(name).then(setCands).catch(() => setCands([])), 300);
    return () => clearTimeout(h);
  }, [name]);
  const used = (id: string) => taken.some((t) => t?.kind === "existing" && t.id === id);
  const split = splitIssuedName(name);
  return (
    <li className="space-y-2 px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-2"><span className="font-mono font-semibold">{name || "(no name yet)"}</span>
        {match?.kind === "existing" && <Badge tone="green">Matched: {match.label}</Badge>}
        {match?.kind === "new" && <Badge tone="blue">New person</Badge>}
        {match && <button type="button" className="text-xs link" onClick={() => onChange(null)}>change</button>}
      </div>
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
            <Button size="sm" onClick={() => onChange({ kind: "new", first_name: [split.first].filter(Boolean).join(" "), last_name: split.last, mobile: payerMobile })}>New person</Button>
          </div>
        </div>
      )}
      {match?.kind === "new" && (
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="First name" required><input className="field" value={match.first_name} onChange={(e) => onChange({ ...match, first_name: e.target.value })} /></Field>
          <Field label="Last name"><input className="field" value={match.last_name} onChange={(e) => onChange({ ...match, last_name: e.target.value })} /></Field>
          <Field label="Mobile" required hint={payerMobile && match.mobile === payerMobile ? "Filled from the payer; change it if they have their own." : undefined}>
            <input className="field" inputMode="tel" value={match.mobile} onChange={(e) => onChange({ ...match, mobile: e.target.value })} />
          </Field>
        </div>
      )}
    </li>
  );
}

/** Field-by-field: what the booking has now vs what the reviewed ticket says. Required before changing a booking that has data. */
function Comparison({ lineId, draft, compared, setCompared, reissue }: { lineId: string; draft: Draft; compared: boolean; setCompared: (v: boolean) => void; reissue: boolean }) {
  const [line, setLine] = useState<Awaited<ReturnType<typeof bookingForCompare>> | undefined>(undefined);
  useEffect(() => { setLine(undefined); bookingForCompare(lineId).then(setLine).catch(() => setLine(null)); }, [lineId]);
  if (line === undefined) return <p className="text-xs text-muted">Loading the booking…</p>;
  if (line === null) return <p role="alert" className="text-xs text-red-700">That booking could not be loaded.</p>;
  const old = (line.details.sectors as Record<string, string>[] | undefined) ?? [];
  const oldT = (line.details.tickets as Record<string, string>[] | undefined) ?? [];
  const n = Math.max(old.length, draft.segments.length);
  const KEYS: [string, (s: DraftSegment) => string, string][] = [
    ["Route", (s) => `${s.from.value}→${s.to.value}`, "route"], ["Departs", (s) => `${s.dep_date.value} ${s.dep_time.value}`.trim(), "dep"],
    ["Arrives", (s) => `${s.arr_date.value} ${s.arr_time.value}`.trim(), "arr"], ["Flight", (s) => s.flight_no.value, "flight_no"],
  ];
  const oldVal = (s: Record<string, string> | undefined, k: string) => !s ? "" : k === "route" ? `${s.from}→${s.to}` : k === "dep" ? `${s.date ?? ""} ${s.dep ?? ""}`.trim() : k === "arr" ? `${s.arr_date ?? ""} ${s.arr ?? ""}`.trim() : s[k] ?? "";
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
      {reissue && (() => {
        const key = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const old = new Set(oldT.map((t) => key(t.number ?? "")));
        const fresh = draft.passengers.flatMap((p) => p.tickets.map((t) => t.number.value)).filter((n) => n.trim() && !old.has(key(n)));
        return fresh.length ? null : (
          <p role="alert" className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-800">No new ticket number on this document, so it isn&apos;t evidence of a reissue. Choose Update if the tickets are unchanged.</p>
        );
      })()}
      <p className="text-xs text-muted">{reissue ? "The old tickets and flights are kept in the booking's history. No new sale is created; prices stay as they are." : "Changed flights are kept in history. Prices stay as they are."}</p>
      <label className="flex items-center gap-2"><input type="checkbox" checked={compared} onChange={(e) => setCompared(e.target.checked)} />I compared every highlighted difference with the original</label>
    </div>
  );
}
