"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, ArrowRight, Inbox, RefreshCw, Search } from "lucide-react";
import { Badge, Button, Card, Empty, Field, PageHeader, cx } from "@/components/ui";
import { fdate, fdatetime, inr } from "@/lib/format";

const SERVICES = { VISA: "Visa assistance", INSURANCE: "Travel insurance", HOLIDAY: "Holiday package", CRUISE: "Cruise holiday" };
const STATUSES = { NEW: "New", CONTACTED: "Contacted", QUOTED: "Quoted", CLOSED: "Closed" };
type Service = keyof typeof SERVICES;
type Status = keyof typeof STATUSES;
type Staff = { id: string; full_name: string; role: string };
export type WebsiteEnquiry = {
  id: string; reference: string; service: Service; status: Status; version: number; environment: "test" | "live";
  createdAt: string; updatedAt: string; consentAt: string; contactVerified: false;
  assignedTo: string | null; internalNote: string | null;
  contact: { name: string; email?: string; phone?: string; preferredChannel: "EMAIL" | "PHONE" | "WHATSAPP" };
  draft: { destination: string; travelWindow: string; adults: number; childAges: number[];
    departureCity?: string; travelStart?: string; travelEnd?: string; durationNights?: number; nationality?: string;
    countryOfResidence?: string; purpose?: string; travellerAges?: number[]; cabinPreference?: string; notes?: string };
  requestedBudget: { amountRupees: number; basis: "TOTAL" | "PER_PERSON" } | null;
};
type Result = { rows: WebsiteEnquiry[]; page: number; total: number; hasMore: boolean; canAssign: boolean; staff: Staff[] };
type Filters = { q: string; status: string; service: string; page: number; environment: "test" | "live" };
const initial: Filters = { q: "", status: "", service: "", page: 1, environment: "live" };

class RequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store", redirect: "error", ...options, signal: options.signal ?? AbortSignal.timeout(20_000) });
  let body;
  try { body = await response.json(); } catch { throw new RequestError("The response could not be checked. Refresh before trying again.", response.status); }
  if (!response.ok) throw new RequestError(typeof body.error === "string" ? body.error : "The request could not be completed.", response.status);
  return body as T;
}
function stateBadge(status: Status) { return <Badge dot tone={status === "NEW" ? "coral" : status === "CONTACTED" ? "blue" : status === "QUOTED" ? "amber" : "grey"}>{STATUSES[status]}</Badge>; }

export default function WebsiteEnquiries() {
  const [filters, setFilters] = useState(initial);
  const [data, setData] = useState<Result | null>(null);
  const [selected, setSelected] = useState<WebsiteEnquiry | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const detail = useRef<HTMLElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const activeId = selected?.id;

  const load = useCallback(async (signal?: AbortSignal) => {
    const current = ++generation.current;
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ ...filters, page: String(filters.page) });
      const result = await request<Result>(`/api/enquiries?${params}`, signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) } : {});
      if (signal?.aborted || current !== generation.current) return;
      setData(result);
      // Never keep a detail row that no longer belongs to the authorized result.
      setSelected(previous => previous ? result.rows.find(row => row.id === previous.id) ?? null : null);
      setDirty(false); setRevision(value => value + 1);
    } catch (cause) {
      if (signal?.aborted || current !== generation.current) return;
      setData(null); setSelected(null); setDirty(false);
      setError(cause instanceof Error ? cause.message : "Enquiries could not be loaded.");
    } finally { if (!signal?.aborted && current === generation.current) setLoading(false); }
  }, [filters]);

  // The authenticated API, rather than local state, is the inbox's source of truth.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);
  useLayoutEffect(() => {
    if (!activeId) return;
    detail.current?.focus({ preventScroll: true });
    if (window.matchMedia("(max-width: 1279px)").matches) detail.current?.scrollIntoView({ block: "start" });
  }, [activeId]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const canLeave = () => !saving && (!dirty || window.confirm("Discard unsaved enquiry changes?"));
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!canLeave()) return;
    const values = new FormData(event.currentTarget);
    setSelected(null); setDirty(false); setNotice("");
    setFilters(previous => ({ q: String(values.get("q") ?? "").trim(), service: String(values.get("service") ?? ""), status: String(values.get("status") ?? ""), page: 1, environment: previous.environment }));
  }
  function choose(row: WebsiteEnquiry) { if (row.id !== activeId && canLeave()) { setSelected(row); setDirty(false); setNotice(""); } }
  async function saved(row: WebsiteEnquiry) {
    setDirty(false); setSelected(row);
    setData(previous => previous ? { ...previous, rows: previous.rows.map(item => item.id === row.id ? row : item) } : previous);
    setNotice(`${row.reference} updated.`);
  }

  return <>
    <PageHeader title="Website enquiries" sub="Travel requests submitted by customers through Max AI. Review, assign and follow up."
      action={<Button disabled={loading || saving} onClick={() => { if (canLeave()) void load(); }}><RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} />Refresh</Button>} />
    <div aria-label="Enquiry environment" className="mb-4 flex flex-wrap gap-2">{(["live", "test"] as const).map(environment => <Button key={environment} aria-pressed={filters.environment === environment} variant={filters.environment === environment ? "primary" : "secondary"} disabled={saving || loading} onClick={() => { if (environment !== filters.environment && canLeave()) { setSelected(null); setDirty(false); setData(null); setNotice(""); setFilters({ ...initial, environment }); } }}>{environment === "live" ? "Live enquiries" : "Test enquiries"}</Button>)}</div>
    {filters.environment === "test" && <p role="status" className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900"><strong>Test enquiries only.</strong> These requests came from the booking website in test mode. They are kept separate from live customer enquiries. Do not treat them as real travel orders.</p>}
    <p className="mb-4 rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-[13px] text-sky-900">These are requests for assistance. An enquiry does not create a customer, case, booking, invoice or payment.</p>
    <form key={filters.environment} aria-label="Filter website enquiries" onSubmit={apply} className={cx("mb-4 items-end gap-3 rounded-[14px] border border-line bg-white p-4 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_180px_160px_auto]", selected ? "hidden xl:grid" : "grid")}>
      <Field label="Search enquiries"><input className="field" name="q" aria-label="Search enquiries" maxLength={100} placeholder="Reference, contact or destination" defaultValue={filters.q} disabled={saving} /></Field>
      <Field label="Service"><select className="field" name="service" aria-label="Service" defaultValue={filters.service} disabled={saving}><option value="">All services</option>{Object.entries(SERVICES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
      <Field label="Status"><select className="field" name="status" aria-label="Status" defaultValue={filters.status} disabled={saving}><option value="">All statuses</option>{Object.entries(STATUSES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
      <Button type="submit" disabled={loading || saving} className="min-h-11"><Search className="h-4 w-4" />Apply filters</Button>
    </form>
    {error && <div role="alert" className="mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}<p className="mt-2">Use Refresh to reload. If your session has ended, sign in again.</p></div>}
    {notice && <p role="status" className="mb-4 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>}
    {loading && <p role="status" className="mb-3 text-sm text-muted">Loading website enquiries…</p>}
    {data && <div className={cx("grid items-start gap-5", selected && "xl:grid-cols-[minmax(300px,0.85fr)_minmax(400px,1.15fr)]")}>
      <div className={cx("min-w-0", selected && "hidden xl:block")}>
        <Card title={`${data.total} ${filters.environment} ${data.total === 1 ? "enquiry" : "enquiries"}`} sub={data.canAssign ? "Website requests · newest first" : "Requests visible to your staff account"} icon={Inbox} pad={false}>
          {!data.rows.length ? <Empty text={filters.q || filters.status || filters.service ? "No enquiries match these filters." : "No website enquiries are available to you yet."} /> : <ul aria-label="Website enquiry results" className="divide-y divide-line">
            {data.rows.map((row, index) => <li key={row.id}><button ref={index === 0 ? first : undefined} type="button" disabled={loading || saving} onClick={() => choose(row)} aria-label={`Open enquiry ${row.reference}`} aria-current={row.id === activeId ? "true" : undefined} className={cx("block w-full px-4 py-4 text-left transition-colors hover:bg-gray-50 disabled:opacity-60", row.id === activeId && "bg-coral-soft/60")}>
              <span className="flex flex-wrap items-center justify-between gap-2"><span className="font-mono text-xs font-semibold text-muted">{row.reference}</span><span className="flex flex-wrap gap-2">{row.environment === "test" && <Badge tone="amber">Test</Badge>}{stateBadge(row.status)}</span></span>
              <span className="mt-2 block break-words text-[15px] font-semibold">{row.draft.destination}</span>
              <span className="mt-1 block text-[13px] text-muted">{SERVICES[row.service]} · {row.draft.travelWindow}</span>
              <span className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs"><span className="break-words font-medium">{row.contact.name}</span><span className="text-muted">{row.assignedTo ? data.staff.find(person => person.id === row.assignedTo)?.full_name ?? "Assigned" : "Unassigned"}</span></span>
              <span className="mt-1 block text-xs text-muted">Received {fdatetime(row.createdAt)} IST</span>
            </button></li>)}
          </ul>}
          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3 text-xs text-muted"><span>Page {data.page}</span><div className="flex gap-2"><Button aria-label="Previous page" size="sm" disabled={loading || saving || data.page <= 1} onClick={() => { if (canLeave()) setFilters(previous => ({ ...previous, page: previous.page - 1 })); }}><ArrowLeft className="h-4 w-4" />Previous</Button><Button aria-label="Next page" size="sm" disabled={loading || saving || !data.hasMore} onClick={() => { if (canLeave()) setFilters(previous => ({ ...previous, page: previous.page + 1 })); }}>Next<ArrowRight className="h-4 w-4" /></Button></div></div>
        </Card>
      </div>
      {selected && <section ref={detail} tabIndex={-1} aria-label={`Enquiry ${selected.reference}`} className="min-w-0 scroll-mt-20 outline-none">
        <Button className="mb-3 xl:hidden" onClick={() => { if (canLeave()) { setSelected(null); setDirty(false); requestAnimationFrame(() => first.current?.focus()); } }} disabled={saving}><ArrowLeft className="h-4 w-4" />Back to enquiries</Button>
        <EnquiryDetail key={`${selected.id}:${selected.version}:${revision}`} row={selected} staff={data.staff} canAssign={data.canAssign} loading={loading} onDirty={setDirty} onBusy={setSaving} onSaved={saved} onRefresh={() => void load()} onAccessDenied={() => { setData(null); setSelected(null); setDirty(false); setError("Your access has changed. Sign in again or ask the administrator to check your permissions."); }} />
      </section>}
    </div>}
  </>;
}

function Detail({ label, children }: { label: string; children: ReactNode }) { return <div className="min-w-0"><dt className="text-xs text-muted">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-sm">{children}</dd></div>; }

function EnquiryDetail({ row, staff, canAssign, loading, onDirty, onBusy, onSaved, onRefresh, onAccessDenied }: {
  row: WebsiteEnquiry; staff: Staff[]; canAssign: boolean; loading: boolean; onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void; onSaved: (row: WebsiteEnquiry) => void; onRefresh: () => void; onAccessDenied: () => void;
}) {
  const [status, setStatus] = useState(row.status);
  const [note, setNote] = useState(row.internalNote ?? "");
  const [assigned, setAssigned] = useState(row.assignedTo ?? "");
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const dirty = status !== row.status || note !== (row.internalNote ?? "") || assigned !== (row.assignedTo ?? "");
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const draft = row.draft;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (inFlight.current || uncertain || !dirty) return;
    inFlight.current = true; setBusy(true); onBusy(true); setError("");
    try {
      const data = await request<{ enquiry: WebsiteEnquiry }>("/api/enquiries", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: row.id, version: row.version, status, internalNote: note.trim(), ...(canAssign ? { assignedTo: assigned || null } : {}) }) });
      if (!data.enquiry || data.enquiry.id !== row.id || data.enquiry.version <= row.version) throw Error("The saved result could not be verified.");
      onSaved(data.enquiry);
    } catch (cause) {
      if (cause instanceof RequestError && [401, 403].includes(cause.status)) { onAccessDenied(); return; }
      const conflict = cause instanceof RequestError && cause.status === 409;
      const definite = cause instanceof RequestError && cause.status >= 400 && cause.status < 500 && !conflict;
      setUncertain(!definite);
      setError(conflict ? "This enquiry changed while you were editing. Refresh the enquiry before making more changes." : cause instanceof Error ? cause.message : "The update could not be checked.");
    } finally { inFlight.current = false; setBusy(false); onBusy(false); }
  }
  return <Card title={row.reference} sub={`Received ${fdatetime(row.createdAt)} IST`} action={<span className="flex flex-wrap justify-end gap-2">{row.environment === "test" && <Badge tone="amber">Test</Badge>}{stateBadge(row.status)}</span>}>
    <h2 className="break-words text-xl font-semibold">{draft.destination}</h2><p className="mt-1 text-sm text-muted">{SERVICES[row.service]}</p>
    <dl className="mt-5 grid gap-x-5 gap-y-4 sm:grid-cols-2">
      <Detail label="Travel window">{draft.travelWindow}</Detail><Detail label="Travellers">{draft.adults} {draft.adults === 1 ? "adult" : "adults"}{draft.childAges.length ? ` · ${draft.childAges.length} ${draft.childAges.length === 1 ? "child" : "children"} (${draft.childAges.length === 1 ? "age" : "ages"} ${draft.childAges.join(", ")})` : ""}</Detail>
      {draft.departureCity && <Detail label="Departure city">{draft.departureCity}</Detail>}{draft.nationality && <Detail label="Passport nationality">{draft.nationality}</Detail>}{draft.purpose && <Detail label="Purpose of travel">{draft.purpose}</Detail>}
      {draft.countryOfResidence && <Detail label="Country of residence">{draft.countryOfResidence}</Detail>}{draft.travellerAges?.length ? <Detail label="Traveller ages">{draft.travellerAges.join(", ")}</Detail> : null}
      {draft.travelStart && <Detail label="Start date">{fdate(draft.travelStart)}</Detail>}{draft.travelEnd && <Detail label="End date">{fdate(draft.travelEnd)}</Detail>}{draft.durationNights && <Detail label="Nights">{draft.durationNights}</Detail>}{draft.cabinPreference && <Detail label="Cabin preference">{draft.cabinPreference}</Detail>}
      {row.requestedBudget && <Detail label="Requested budget">{inr(row.requestedBudget.amountRupees)} {row.requestedBudget.basis === "PER_PERSON" ? "per person" : "total"}<span className="mt-1 block text-xs text-muted">Customer preference, not a quote or payment.</span></Detail>}
      {draft.notes && <div className="sm:col-span-2"><Detail label="Travel preferences">{draft.notes}</Detail></div>}
    </dl>
    <div className="my-5 border-t border-line" />
    <div className="flex flex-wrap items-center gap-2"><h3 className="text-sm font-semibold">Customer contact</h3><Badge tone="amber">Unverified contact</Badge></div>
    <p className="mt-2 text-xs text-muted">Details were supplied with the enquiry. Confirm the traveller’s identity before sharing sensitive information.</p>
    <dl className="mt-4 grid gap-4 sm:grid-cols-2"><Detail label="Contact name">{row.contact.name}</Detail><Detail label="Preferred reply">{row.contact.preferredChannel === "EMAIL" ? "Email" : row.contact.preferredChannel === "WHATSAPP" ? "WhatsApp" : "Phone call"}</Detail>
      {row.contact.email && <Detail label="Email">{row.contact.email}</Detail>}{row.contact.phone && <Detail label="Phone / WhatsApp">{row.contact.phone}</Detail>}<Detail label="Contact consent received">{fdatetime(row.consentAt)} IST</Detail>
    </dl>
    <form aria-label="Enquiry follow-up" onSubmit={save} className="mt-5 space-y-4 border-t border-line pt-5">
      <h3 className="text-sm font-semibold">Follow-up</h3>
      <fieldset disabled={busy || loading || uncertain} className="space-y-4">
        {canAssign ? <Field label="Assigned to"><select className="field" aria-label="Assigned to" value={assigned} onChange={event => setAssigned(event.target.value)}><option value="">Unassigned</option>{row.assignedTo && !staff.some(person => person.id === row.assignedTo) && <option value={row.assignedTo}>Current assignee (unavailable)</option>}{staff.map(person => <option key={person.id} value={person.id}>{person.full_name}{person.role === "boss" ? " · Admin" : ""}</option>)}</select></Field> : <p className="text-sm text-muted">Assigned to {staff.find(person => person.id === row.assignedTo)?.full_name ?? "your team"}. An administrator manages assignment.</p>}
        <Field label="Enquiry status"><select className="field" aria-label="Enquiry status" value={status} onChange={event => setStatus(event.target.value as Status)}>{Object.entries(STATUSES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
        <Field label="Internal follow-up note"><textarea className="field min-h-28 resize-y" aria-label="Internal follow-up note" aria-describedby="enquiry-note-hint" maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></Field>
        <p id="enquiry-note-hint" className="text-xs text-muted">For your team only. Record the next step; keep passwords, payment details and medical documents out of this note.</p>
      </fieldset>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {uncertain ? <div className="space-y-2"><p className="text-sm text-muted">The current version must be reloaded before another update. Your unsaved text is shown above for reference.</p><Button disabled={busy || loading} onClick={onRefresh}><RefreshCw className="h-4 w-4" />Refresh enquiry</Button></div> : <div className="flex flex-wrap items-center gap-2"><Button variant="primary" type="submit" className="min-h-11" disabled={busy || loading || !dirty}>{busy ? "Saving…" : "Save follow-up"}</Button>{dirty && <Button disabled={busy || loading} onClick={() => { setStatus(row.status); setNote(row.internalNote ?? ""); setAssigned(row.assignedTo ?? ""); setError(""); }}>Discard changes</Button>}</div>}
      <p className="text-xs text-muted">Last updated {fdatetime(row.updatedAt)} IST · Changing this status does not send a customer message.</p>
    </form>
  </Card>;
}
