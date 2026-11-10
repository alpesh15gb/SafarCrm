"use client";
import { useEffect, useMemo, useState } from "react";
import { Copy, MoreHorizontal, Pencil, Plus, Trash2, X, Ban, Undo2 } from "lucide-react";
import { Badge, Button, Card, Empty, Field, Money, ServiceIcon, StatusBadge, cx } from "@/components/ui";
import { Confirm, Dialog, Menu, More, Toggle, useAction } from "@/components/client";
import { SupplierPicker } from "@/components/pickers";
import { SupplierQuickForm } from "@/components/forms/supplier-quick";
import { DropZone, FileItem, withHistory } from "@/components/files";
import { BookingDetails } from "@/components/trip-view";
import { useApp } from "@/components/shell/shell";
import { cancelLine, deleteLine, duplicateLine, reinstateLine, saveLine, setLineVisible } from "@/actions/bookings";
import { DEFAULT_KIND, SERVICES, SERVICE_FIELDS, SERVICE_LABEL, visaTemplate, type FieldDef, type Service } from "@/lib/constants";
import { VisaPanel } from "@/components/visa-panel";
import { lineProblem } from "@/lib/validate";
import { amount, cancelBreakdown, commissionOf, lineProfit, moneyProblem } from "@/lib/money";
import { offsetLabel, sectorTimeIssues } from "@/lib/flight-time";
import { InlineTravellerAdd } from "@/components/inline-traveller";
import { FlightPassengers, IssueList, type Pax } from "@/components/flight-pax";
import { PAX_LABEL, checkAirport, checkFlightNo, checkPnr, checkTicket, airlineCodeOf, normFlightNo, normTicket, paxType } from "@/lib/iata";
import { fdate, inr } from "@/lib/format";

export type Line = {
  id: string; case_id: string; service: Service; status: string; reference: string | null; traveller_ids: string[];
  supplier_id: string | null; supplier: { id: string; name: string } | null;
  supplier_cost: number; selling_price: number; commission_type: "amount" | "percent"; commission_value: number; commission_amount: number;
  gst: number; payment_due_date: string | null; supplier_due_date: string | null; notes: string | null; details: Record<string, unknown>;
  visible_to_client: boolean; service_date: string | null; summary: string | null; cancel_reason: string | null;
  cancellation_charge: number; refund_to_client: number; refund_from_supplier: number; cancelled_at: string | null;
  money?: { billed: number; sale: number; cost: number; profit: number | null; margin: number | null };
};
import type { FileRow } from "./files";
export type { FileRow };
type Lookups = Record<string, { value: string; extra: Record<string, string> }[]>;
type Cust = { full_name: string; mobile: string; whatsapp: string | null; email: string | null };

type Trip = { start: string | null; end: string | null };
/** What we know about airports and airlines, for IATA checks. */
type Iata = { airports: Set<string>; indian: Set<string>; airlineByCode: Map<string, string>; tzByCode: Map<string, string> };
function iataFrom(lookups: Lookups): Iata {
  return {
    airports: new Set((lookups.airport ?? []).map((a) => a.value)),
    indian: new Set((lookups.airport ?? []).filter((a) => a.extra?.country === "IN").map((a) => a.value)),
    airlineByCode: new Map((lookups.airline ?? []).filter((a) => a.extra?.code).map((a) => [a.extra.code, a.value])),
    // only airports whose zone is recorded; an unknown zone stays unknown
    tzByCode: new Map((lookups.airport ?? []).filter((a) => a.extra?.tz).map((a) => [a.value, a.extra.tz])),
  };
}
const isIntl = (d: Record<string, unknown>, iata: Iata) =>
  ((d.sectors as { from?: string; to?: string }[]) ?? []).some((x) => [x.from, x.to].some((c) => c && /^[A-Z]{3}$/.test(c) && !iata.indian.has(c)));

export function BookingsTab({ caseId, lines, travellers, maxId, customer, lookups, files, trip }: {
  caseId: string; lines: Line[]; travellers: Pax[]; maxId: string; customer: Cust; lookups: Lookups; files: FileRow[]; trip: Trip;
}) {
  const [dlg, setDlg] = useState<{ line?: Line; service?: Service } | null>(null);
  const iata = useMemo(() => iataFrom(lookups), [lookups]);
  const [cancel, setCancel] = useState<Line | null>(null);

  return (
    <div className="space-y-3">
      <Datalists lookups={lookups} />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] text-muted">Add:</span>
        {SERVICES.map((s) => (
          <Button key={s} size="sm" onClick={() => setDlg({ service: s })}><ServiceIcon service={s} />{SERVICE_LABEL[s]}</Button>
        ))}
      </div>
      {lines.length === 0 && <Card><Empty text="No bookings yet. Add the first flight, hotel or other service." action={<Button variant="primary" onClick={() => setDlg({ service: "flight" })}><Plus className="h-4 w-4" />Add booking</Button>} /></Card>}
      {lines.map((l) => (
        <LineCard
          key={l.id}
          line={l}
          travellers={travellers}
          maxId={maxId}
          customer={customer}
          files={files.filter((f) => f.booking_line_id === l.id)}
          onEdit={() => setDlg({ line: l })}
          onCancel={() => setCancel(l)}
          trip={trip}
          iata={iata}
        />
      ))}
      <LineDialog open={!!dlg} onClose={() => setDlg(null)} caseId={caseId} line={dlg?.line} service={dlg?.service} travellers={travellers} iata={iata} />
      <CancelDialog line={cancel} onClose={() => setCancel(null)} />
    </div>
  );
}

function Datalists({ lookups }: { lookups: Lookups }) {
  return (
    <>
      {["airline", "hotel_chain", "insurer", "city", "country"].map((k) => (
        <datalist key={k} id={`dl-${k}`}>{(lookups[k] ?? []).map((v) => <option key={v.value} value={v.value} />)}</datalist>
      ))}
      <datalist id="dl-airport">{(lookups.airport ?? []).map((v) => <option key={v.value} value={v.value}>{v.extra.city}</option>)}</datalist>
    </>
  );
}

function LineCard({ line: l, travellers, maxId, customer, files, onEdit, onCancel, trip, iata }: {
  line: Line; travellers: Pax[]; maxId: string; customer: Cust; files: FileRow[]; onEdit: () => void; onCancel: () => void; trip: Trip; iata: Iata;
}) {
  const { me } = useApp();
  const { run, pending } = useAction();
  const [del, setDel] = useState(false);
  const names = travellers.filter((t) => l.traveller_ids.includes(t.id)).map((t) => t.full_name);
  const cancelled = l.status === "cancelled";
  const grouped = withHistory(files);
  const profit = l.money?.profit;

  return (
    <Card pad={false} className={cx(cancelled && "bg-gray-50")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-3">
        <span className={cx("flex h-8 w-8 items-center justify-center rounded-lg", cancelled ? "bg-gray-100 text-muted" : "bg-coral-soft text-coral-dark")}><ServiceIcon service={l.service} /></span>
        <div className="min-w-0 flex-1">
          <div className={cx("font-medium", cancelled && "line-through decoration-gray-400")}>{SERVICE_LABEL[l.service]}{l.summary && ` · ${l.summary}`}</div>
          <div className="text-xs text-muted">
            {[fdate(l.service_date), l.supplier?.name, l.reference && `Ref ${l.reference}`].filter(Boolean).join(" · ")}
          </div>
        </div>
        <Toggle checked={l.visible_to_client} disabled={me.role !== "boss" || pending} onChange={(v) => run(() => setLineVisible(l.id, v))} label={<span className="text-xs text-muted">Visible to client</span>} />
        {(l.service !== "visa" || cancelled) && <StatusBadge status={l.status} />}
        <Button size="sm" onClick={onEdit}><Pencil className="h-3.5 w-3.5" />Edit</Button>
        <Menu trigger={<Button size="sm" aria-label="More" className="!px-2"><MoreHorizontal className="h-4 w-4" /></Button>}>
          <button type="button" onClick={() => run(() => duplicateLine(l.id))}><Copy className="mr-2 inline h-4 w-4" />{l.service === "visa" ? "Copy for another traveller" : "Duplicate (return trip)"}</button>
          {!cancelled && <button type="button" onClick={onCancel}><Ban className="mr-2 inline h-4 w-4" />Cancel booking</button>}
          {cancelled && <button type="button" onClick={() => run(() => reinstateLine(l.id))}><Undo2 className="mr-2 inline h-4 w-4" />Reinstate</button>}
          {me.role === "boss" && <button type="button" className="text-red-600" onClick={() => setDel(true)}><Trash2 className="mr-2 inline h-4 w-4" />Delete</button>}
        </Menu>
      </div>
      <div className="grid gap-4 p-4 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-3 text-sm">
          {!cancelled && lineProblem(l.service, l.details ?? {}) && (
            <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-800">
              <b>Incomplete:</b> {lineProblem(l.service, l.details ?? {})} Press Edit to fix it. Clients don&apos;t see this booking until it is complete.
            </div>
          )}
          {l.service === "visa"
            ? <VisaPanel lineId={l.id} details={l.details} travellers={travellers.filter((t) => l.traveller_ids.includes(t.id))} trip={trip} readOnly={cancelled} />
            : <BookingDetails service={l.service} details={l.details} />}
          {l.service === "flight" && !cancelled && (
            <FlightPassengers pax={travellers.filter((t) => l.traveller_ids.includes(t.id))} travelDate={l.service_date} international={isIntl(l.details, iata)} />
          )}
          {names.length > 0 && l.service !== "flight" && <div className="text-xs text-muted">Travellers: {names.join(", ")}</div>}
          {l.notes && <div className="whitespace-pre-wrap rounded-lg bg-gray-50 px-3 py-2 text-[13px]">{l.notes}</div>}
          {cancelled && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-800">
              <div className="font-medium">Cancelled{l.cancel_reason && `: ${l.cancel_reason}`}</div>
              {(() => {
                const b = cancelBreakdown({ ...l, base_fare: null });
                return (
                  <div className="mt-1 tabular">
                    Kept from client {inr(l.selling_price)} − {inr(l.refund_to_client)} = <b>{inr(b.kept)}</b> · Supplier keeps (charge) {inr(l.supplier_cost)} − {inr(l.refund_from_supplier)} = <b>{inr(b.charge)}</b>
                    {me.can_see_profit && <> · Profit {inr(b.kept)} − {inr(b.charge)} = <b>{inr(b.profit)}</b> (commission doesn&apos;t count after cancelling)</>}
                  </div>
                );
              })()}
            </div>
          )}
        </div>
        <div className="space-y-1 rounded-lg bg-gray-50 p-3 text-[13px]">
          <Row k={l.service === "visa" ? "Charged to client" : "Selling price"} v={<Money value={l.selling_price} />} />
          {Number(l.gst) > 0 && <Row k="GST (not profit)" v={<Money value={l.gst} />} />}
          <Row k={l.service === "visa" ? "Our cost (embassy + VFS)" : "Supplier cost"} v={<Money value={l.supplier_cost} />} />
          {me.can_see_profit && (l.service !== "visa" || Number(l.commission_amount) > 0) && <Row k={`Commission${l.commission_type === "percent" ? ` (${l.commission_value}% of ${l.service === "flight" && Number(l.details?.base_fare) > 0 ? "base fare" : "cost"})` : ""}`} v={<Money value={l.commission_amount} />} />}
          {cancelled && <Row k="Refunds (client / supplier)" v={<>{inr(l.refund_to_client)} / {inr(l.refund_from_supplier)}</>} />}
          {me.can_see_profit && profit !== null && profit !== undefined && (
            <div className="mt-1 flex items-center justify-between border-t border-line pt-1.5 font-medium">
              <span>Profit {l.money?.margin != null && <span className="font-normal text-muted">({l.money.margin}%)</span>}</span>
              <span className="flex items-center gap-1.5">{Number(profit) < 0 && <Badge tone="red">Loss</Badge>}<Money value={profit} profit /></span>
            </div>
          )}
          {l.payment_due_date && <Row k="Client payment due" v={fdate(l.payment_due_date)} />}
          {l.supplier_due_date && <Row k="Supplier payment due" v={fdate(l.supplier_due_date)} />}
        </div>
      </div>
      <div className="space-y-2 border-t border-line px-4 py-3">
        {grouped.map(({ file, history }) => <FileItem key={file.id} f={file} history={history} maxId={maxId} customer={customer} />)}
        <DropZone compact fields={{ target: "line", case_id: l.case_id, line_id: l.id, kind: DEFAULT_KIND[l.service] }} label={grouped.length ? "Add another file" : `Drop the ${l.service === "visa" ? "visa copy or application form" : "ticket, voucher or policy"} here (PDF, JPG, PNG up to 10 MB)`} />
      </div>
      <Confirm open={del} onClose={() => setDel(false)} title="Delete this booking?" text="This removes the line and its numbers from the P&L. To keep history, cancel it instead." confirmLabel="Delete" pending={pending}
        onConfirm={() => run(() => deleteLine(l.id), { then: () => setDel(false) })} />
    </Card>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-muted">{k}</span><span className="tabular">{v}</span></div>;
}

// ---------------------------------------------------------------- add / edit
// date = departure local date; arr_date = arrival local date (explicit, never inferred from the times)
type Sector = { from: string; to: string; date: string; airline: string; flight_no: string; dep: string; arr: string; arr_date?: string; dep_tz?: string; arr_tz?: string };
const blankSector = (): Sector => ({ from: "", to: "", date: "", airline: "", flight_no: "", dep: "", arr: "", arr_date: "" });
type Ticket = { passenger: string; number: string; customer_id?: string; name_as_issued?: string; source?: string };

const VISA_CHECKLIST = [
  "Passport (valid 6+ months, 2 blank pages)", "Recent photo, white background", "Confirmed return flight tickets", "Hotel booking",
  "Bank statement, last 6 months", "Income tax returns, last 2 years", "Leave letter or business proof", "Travel insurance",
].join("\n");

function blankDetails(s: Service): Record<string, unknown> {
  if (s === "flight") return { trip_type: "one-way", cabin: "Economy", sectors: [blankSector()], tickets: [] };
  if (s === "visa") return { visa_type: "Tourist", mode: "e-Visa", entry: "Single", application_status: "Documents pending", documents: VISA_CHECKLIST };
  return {};
}

function LineDialog({ open, onClose, caseId, line, service: initService, travellers, iata }: {
  open: boolean; onClose: () => void; caseId: string; line?: Line; service?: Service; travellers: Pax[]; iata: Iata;
}) {
  const { me } = useApp();
  const { run, pending } = useAction();
  const [service, setService] = useState<Service>("flight");
  const [supplier, setSupplier] = useState<{ id: string; label: string; raw?: { default_commission: number } } | null>(null);
  const [addSup, setAddSup] = useState<string | null>(null);
  const [status, setStatus] = useState("pending");
  const [reference, setReference] = useState("");
  const [trav, setTrav] = useState<string[]>([]);
  const [d, setD] = useState<Record<string, unknown>>({});
  const [m, setM] = useState({ supplier_cost: "", selling_price: "", commission_type: "amount" as "amount" | "percent", commission_value: "", gst: "", payment_due_date: "", supplier_due_date: "" });
  const [notes, setNotes] = useState("");
  const [visible, setVisible] = useState(true);
  const [tried, setTried] = useState(false);   // show "what's missing" only after a save attempt
  // people added inline while this form is open (the page's traveller list refreshes behind the dialog)
  const [added, setAdded] = useState<Pax[]>([]);
  const allTravellers = useMemo(() => [...travellers, ...added.filter((a) => !travellers.some((t) => t.id === a.id))], [travellers, added]);

  // reset only when the dialog opens or a different booking is opened: a background refresh must never wipe what was typed
  useEffect(() => {
    if (!open) return;
    setAdded([]);
    if (line) {
      setService(line.service);
      setSupplier(line.supplier ? { id: line.supplier.id, label: line.supplier.name } : null);
      setStatus(line.status); setReference(line.reference ?? ""); setTrav(line.traveller_ids);
      setD(line.details ?? {});
      setM({
        supplier_cost: String(line.supplier_cost ?? ""), selling_price: String(line.selling_price ?? ""), commission_type: line.commission_type,
        commission_value: String(line.commission_value ?? ""), gst: String(line.gst ?? ""), payment_due_date: line.payment_due_date ?? "", supplier_due_date: line.supplier_due_date ?? "",
      });
      setNotes(line.notes ?? ""); setVisible(line.visible_to_client);
    } else {
      const s = initService ?? "flight";
      setService(s); setSupplier(null); setStatus("pending"); setReference(""); setTrav(travellers.map((t) => t.id));
      setD(blankDetails(s));
      setM({ supplier_cost: "", selling_price: "", commission_type: "amount", commission_value: "", gst: "", payment_due_date: "", supplier_due_date: "" });
      setNotes(""); setVisible(true);
    }
    setAddSup(null);
    setTried(false);
  }, [open, line?.id, initService]); // eslint-disable-line react-hooks/exhaustive-deps

  const num = amount;
  const isCancelled = line?.status === "cancelled";
  const moneyNow = {
    status: isCancelled ? "cancelled" : "active", selling_price: m.selling_price, supplier_cost: m.supplier_cost,
    commission_type: m.commission_type, commission_value: m.commission_value, base_fare: service === "flight" ? (d.base_fare as number) : null,
    refund_to_client: line?.refund_to_client, refund_from_supplier: line?.refund_from_supplier,
  };
  const commission = isCancelled ? 0 : commissionOf(moneyNow);
  const profit = lineProfit(moneyNow);
  const margin = num(m.selling_price) ? Math.round((profit / num(m.selling_price)) * 1000) / 10 : null;
  const nights = useMemo(() => {
    if (service !== "hotel" || !d.check_in || !d.check_out) return null;
    return Math.round((Date.parse(String(d.check_out)) - Date.parse(String(d.check_in))) / 86400000);
  }, [service, d.check_in, d.check_out]);

  const setDet = (k: string, v: unknown) => setD((x) => {
    // picking a visa country fills in the usual checklist and how it is applied (until someone ticks a box)
    if (service === "visa" && k === "country" && !(x.checklist as { done: boolean }[] | undefined)?.some((c) => c.done)) {
      const t = visaTemplate(String(v));
      return { ...x, country: v, mode: t.mode, checklist: t.checklist.map((item) => ({ item, done: false })) };
    }
    return { ...x, [k]: v };
  });
  const sectors = (d.sectors as Sector[]) ?? [];
  // return trip: typing the outbound airports fills the return leg in reverse, until someone edits the return leg
  function setAirport(i: number, key: "from" | "to", raw: string) {
    const v = raw.toUpperCase();
    const tzKey = (k: "from" | "to") => (k === "from" ? "dep_tz" : "arr_tz");
    // the airport's time zone comes from the airport list when it is recorded there; otherwise it stays unknown
    const withTz = (s: Sector, k: "from" | "to", code: string): Sector => ({ ...s, [k]: code, [tzKey(k)]: iata.tzByCode.get(code) ?? "" });
    const next = sectors.map((x, j) => (j === i ? withTz(x, key, v) : x));
    if (d.trip_type === "return" && i === 0 && next[1]) {
      const mirror = key === "from" ? "to" : "from";
      const old = sectors[0][key];
      if (!next[1][mirror] || next[1][mirror] === old) next[1] = withTz(next[1], mirror, v);
    }
    setDet("sectors", next);
  }
  // a ticket belongs to a person (customer_id); older tickets without one are matched by name
  const tickets = (d.tickets as Ticket[]) ?? [];
  const isMine = (x: { passenger: string; customer_id?: string }, t: { id: string; full_name: string }) => (x.customer_id ? x.customer_id === t.id : x.passenger === t.full_name);

  function setTripType(t: string) {
    let s = sectors.length ? [...sectors] : [blankSector()];
    if (t === "return" && s.length < 2) s = [s[0], { ...blankSector(), from: s[0].to, to: s[0].from, airline: s[0].airline }];
    if (t === "one-way") s = s.slice(0, 1);
    setD((x) => ({ ...x, trip_type: t, sectors: s }));
  }

  const visaPerPerson = service === "visa" && !line && trav.length > 1;
  // check before sending, and say exactly what is missing
  // the same checks the server runs: an unreadable amount is refused, an empty one means "not priced yet"
  const problem = lineProblem(service, d)
    ?? moneyProblem(service === "visa" ? "Our cost" : "Supplier cost", m.supplier_cost)
    ?? moneyProblem(service === "visa" ? "Charge to client" : "Selling price", m.selling_price)
    ?? moneyProblem("Commission", m.commission_value) ?? moneyProblem("GST", m.gst) ?? moneyProblem("Base fare", d.base_fare);
  const unpriced = !m.selling_price.trim() && !m.supplier_cost.trim();
  const save = () => {
    setTried(true);
    if (problem) return;
    return run(
      () => visaPerPerson ? saveVisaPerPerson() : saveLine({
        id: line?.id, case_id: caseId, service, supplier_id: supplier?.id ?? null, status, reference, traveller_ids: trav,
        supplier_cost: m.supplier_cost, selling_price: m.selling_price, commission_type: m.commission_type, commission_value: m.commission_value,
        gst: m.gst, payment_due_date: m.payment_due_date || null, supplier_due_date: line ? m.supplier_due_date || null : undefined, notes,
        details: service === "hotel" && nights !== null ? { ...d, nights } : d, visible_to_client: visible,
      }),
      { then: () => onClose() },
    );
  };
  // a visa is decided per person, so make one file per traveller
  async function saveVisaPerPerson() {
    for (const id of trav) {
      const r = await saveLine({
        case_id: caseId, service, supplier_id: supplier?.id ?? null, status: "pending", reference, traveller_ids: [id],
        supplier_cost: m.supplier_cost, selling_price: m.selling_price, commission_type: m.commission_type, commission_value: m.commission_value,
        gst: m.gst, payment_due_date: m.payment_due_date || null, notes, details: d, visible_to_client: visible,
      });
      if (!r.ok) return r;
    }
    return { ok: true as const, message: `${trav.length} visa files created, one per traveller` };
  }

  const fields = SERVICE_FIELDS[service];
  const isVisa = service === "visa";
  return (
    <Dialog open={open} onClose={onClose} wide title={line ? `Edit ${SERVICE_LABEL[service].toLowerCase()} booking` : `Add ${SERVICE_LABEL[service].toLowerCase()} booking`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={pending} onClick={save}>{line ? "Save booking" : "Add booking"}</Button></>}>
      <div className="space-y-4">
        {!line && (
          <div className="flex flex-wrap gap-1.5">
            {SERVICES.map((s) => (
              <button key={s} type="button" onClick={() => { setService(s); setD(blankDetails(s)); }}
                className={cx("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px]", s === service ? "border-coral bg-coral-soft text-coral-dark" : "border-line text-muted")}>
                <ServiceIcon service={s} />{SERVICE_LABEL[s]}
              </button>
            ))}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier">
            {addSup !== null ? (
              <div className="rounded-lg border border-dashed border-line p-3">
                <SupplierQuickForm initialName={addSup} onCreated={(s) => { setSupplier({ id: s.id, label: s.name }); setAddSup(null); }} />
                <button type="button" className="mt-2 text-xs link" onClick={() => setAddSup(null)}>Pick an existing supplier</button>
              </div>
            ) : (
              <SupplierPicker value={supplier} service={service}
                onChange={(o) => { setSupplier(o); if (o?.raw?.default_commission && !m.commission_value) setM((x) => ({ ...x, commission_type: "percent", commission_value: String(o.raw.default_commission) })); }}
                footer={(q, close) => <button type="button" className="w-full rounded px-2 py-1.5 text-left text-sm link" onClick={() => { setAddSup(q); close(); }}>+ Quick add supplier{q ? ` “${q}”` : ""}</button>} />
            )}
          </Field>
          {!isVisa && <Field label="Status">
            <select className="field" value={status} disabled={status === "cancelled"} onChange={(e) => setStatus(e.target.value)}>
              <option value="pending">Pending</option><option value="confirmed">Confirmed</option>
              {status === "cancelled" && <option value="cancelled">Cancelled</option>}
            </select>
          </Field>}
        </div>

        {service === "flight" && (
          <div className="space-y-2">
            <div className="text-[13px] font-medium">Sectors <span className="text-coral">*</span> <span className="font-normal text-muted">From and To airport codes are needed</span></div>
            {sectors.map((s, i) => (
              <div key={i} className="grid grid-cols-2 gap-2 rounded-lg bg-gray-50 p-2 sm:grid-cols-[64px_64px_132px_1fr_84px_76px_132px_76px_24px]">
                <input className="field uppercase" list="dl-airport" placeholder="From" aria-label={`Sector ${i + 1} from airport`} value={s.from} onChange={(e) => setAirport(i, "from", e.target.value)} />
                <input className="field uppercase" list="dl-airport" placeholder="To" aria-label={`Sector ${i + 1} to airport`} value={s.to} onChange={(e) => setAirport(i, "to", e.target.value)} />
                <input className="field col-span-2 sm:col-span-1" type="date" aria-label={`Sector ${i + 1} date`} title="Flight date" value={s.date} onChange={(e) => setDet("sectors", sectors.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
                <input className="field" list="dl-airline" placeholder="Airline" aria-label={`Sector ${i + 1} airline`} value={s.airline} onChange={(e) => setDet("sectors", sectors.map((x, j) => (j === i ? { ...x, airline: e.target.value } : x)))} />
                <input className="field" placeholder="Flight no." aria-label={`Sector ${i + 1} flight number`} value={s.flight_no}
                  onChange={(e) => setDet("sectors", sectors.map((x, j) => (j === i ? { ...x, flight_no: e.target.value.toUpperCase() } : x)))}
                  onBlur={(e) => {
                    // "6e6311" → "6E 6311", and fill the airline from its IATA code
                    const fno = normFlightNo(e.target.value);
                    const name = iata.airlineByCode.get(airlineCodeOf(fno) ?? "");
                    setDet("sectors", sectors.map((x, j) => (j === i ? { ...x, flight_no: fno, airline: x.airline || name || x.airline } : x)));
                  }} />
                <input className="field" type="time" title="Departure" aria-label={`Sector ${i + 1} departure time`} value={s.dep} onChange={(e) => setDet("sectors", sectors.map((x, j) => (j === i ? { ...x, dep: e.target.value } : x)))} />
                <input className="field col-span-2 sm:col-span-1" type="date" title="Arrival date (local, from the ticket)" aria-label={`Sector ${i + 1} arrival date`} value={s.arr_date ?? ""} onChange={(e) => setDet("sectors", sectors.map((x, j) => (j === i ? { ...x, arr_date: e.target.value } : x)))} />
                <span className="relative">
                  <input className="field" type="time" title="Arrival time (local)" aria-label={`Sector ${i + 1} arrival time`} value={s.arr} onChange={(e) => setDet("sectors", sectors.map((x, j) => (j === i ? { ...x, arr: e.target.value } : x)))} />
                  {offsetLabel(s) ? <sup className="absolute -right-1 -top-1 rounded bg-coral px-1 text-[10px] font-semibold text-white" aria-label={`Arrives ${offsetLabel(s)} day`}>{offsetLabel(s)}</sup> : null}
                </span>
                <button type="button" aria-label="Remove sector" className="text-muted hover:text-red-600 disabled:opacity-30" disabled={sectors.length === 1} onClick={() => setDet("sectors", sectors.filter((_, j) => j !== i))}><X className="h-4 w-4" /></button>
              </div>
            ))}
            <IssueList issues={[
              ...sectors.flatMap((x) => [checkAirport(x.from, iata.airports), checkAirport(x.to, iata.airports), checkFlightNo(x.flight_no)]),
              ...sectors.flatMap((x, i) => sectorTimeIssues(x, sectors.length > 1 ? `Sector ${i + 1}` : `${x.from || "?"} → ${x.to || "?"}`)),
            ]} />
            <Button size="sm" onClick={() => { setDet("sectors", [...sectors, { ...blankSector(), from: sectors.at(-1)?.to ?? "" }]); if (sectors.length >= 1 && d.trip_type === "one-way") setDet("trip_type", "multi-city"); }}><Plus className="h-3.5 w-3.5" />Add sector</Button>
          </div>
        )}

        <DetailFields defs={fields.main} d={d} set={(k, v) => (k === "trip_type" ? setTripType(String(v)) : setDet(k, v))} />
        {service === "flight" && <IssueList issues={[checkPnr(String(d.pnr ?? ""))]} />}
        {service === "hotel" && nights !== null && <p className="text-[13px] text-muted">{nights} night{nights === 1 ? "" : "s"}</p>}

        {isVisa && Array.isArray(d.checklist) && (d.checklist as unknown[]).length > 0 && (
          <p className="rounded-lg bg-emerald-50 px-3 py-2 text-[13px] text-emerald-900">
            Checklist ready: {(d.checklist as unknown[]).length} documents for {String(d.country)}. You can tick them off on the booking card.
          </p>
        )}
        <Field label={isVisa ? "Who needs this visa?" : "Travellers on this booking"} hint={visaPerPerson ? `We'll make ${trav.length} visa files, one per person, because each is approved separately.` : undefined}>
          {allTravellers.length === 0 && <p className="text-[13px] text-amber-800">This case has no travellers yet. Add one below; what you typed here stays.</p>}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {allTravellers.map((t) => (
              <label key={t.id} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={trav.includes(t.id)} onChange={(e) => setTrav((x) => (e.target.checked ? [...x, t.id] : x.filter((y) => y !== t.id)))} />{t.full_name}
                {service === "flight" && (() => { const pt = paxType(t.dob, sectors[0]?.date || new Date().toISOString().slice(0, 10)); return pt ? <span className="text-xs text-muted">· {PAX_LABEL[pt]}</span> : null; })()}
              </label>
            ))}
          </div>
          <InlineTravellerAdd caseId={caseId} exclude={allTravellers.map((t) => t.id)}
            onAdded={(p) => { setAdded((a) => [...a, { id: p.id, full_name: p.full_name } as Pax]); setTrav((x) => (x.includes(p.id) ? x : [...x, p.id])); }} />
        </Field>
        {unpriced && !isCancelled && (
          <p className="rounded-lg bg-sky-50 px-3 py-2 text-[13px] text-sky-900">No prices entered yet. That is fine to save; the booking is marked “not priced” until someone enters them (enter 0 if it really is free).</p>
        )}

        <div className="rounded-lg border border-line p-3">
          <div className="grid gap-3 sm:grid-cols-4">
            <Field label={isVisa ? "Our cost (₹)" : "Supplier cost (₹)"} hint={isVisa ? `Embassy + VFS fees${visaPerPerson ? ", per person" : ""}` : undefined}><input className="field tabular" inputMode="decimal" value={m.supplier_cost} onChange={(e) => setM({ ...m, supplier_cost: e.target.value })} /></Field>
            <Field label={isVisa ? "Charge to client (₹)" : "Selling price (₹)"} hint={isVisa ? `Fees + our service charge${visaPerPerson ? ", per person" : ""}` : "Without GST"}><input className="field tabular" inputMode="decimal" value={m.selling_price} onChange={(e) => setM({ ...m, selling_price: e.target.value })} /></Field>
            {!isVisa && <Field label="Commission">
              <div className="flex">
                <input className="field tabular !rounded-r-none" inputMode="decimal" value={m.commission_value} onChange={(e) => setM({ ...m, commission_value: e.target.value })} />
                <select className="field !w-16 !rounded-l-none !border-l-0 !px-2" value={m.commission_type} onChange={(e) => setM({ ...m, commission_type: e.target.value as "amount" | "percent" })}>
                  <option value="amount">₹</option><option value="percent">%</option>
                </select>
              </div>
            </Field>}
            <Field label="GST (₹, optional)"><input className="field tabular" inputMode="decimal" value={m.gst} onChange={(e) => setM({ ...m, gst: e.target.value })} /></Field>
          </div>
          {!supplier && num(m.supplier_cost) > 0 && addSup === null && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">Who do we pay this {inr(num(m.supplier_cost))} to? Choose the supplier at the top, so it shows in what we owe.</p>
          )}
          {me.can_see_profit && (
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg bg-gray-50 px-3 py-2 text-[13px]">
              {!isVisa && !isCancelled && <span>Commission <b className="tabular">{inr(commission)}</b></span>}
              {isCancelled && <span className="text-red-700">Cancelled: profit is (selling price − refund to client) − (supplier cost − refund from supplier). Commission doesn&apos;t count.</span>}
              <span>{isCancelled ? "Profit after cancellation" : "Profit"} <b className={cx("tabular", profit < 0 ? "text-red-600" : "text-emerald-700")}>{inr(profit)}</b></span>
              {margin !== null && <span>Margin <b className="tabular">{margin}%</b></span>}
              {profit < 0 && <Badge tone="red">Loss</Badge>}
              <span className="text-muted">Client pays {inr(num(m.selling_price) + num(m.gst))}</span>
            </div>
          )}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Client payment due date"><input className="field" type="date" value={m.payment_due_date} onChange={(e) => setM({ ...m, payment_due_date: e.target.value })} /></Field>
            {line && <Field label="Supplier payment due" hint="Set from the supplier's credit days"><input className="field" type="date" value={m.supplier_due_date} onChange={(e) => setM({ ...m, supplier_due_date: e.target.value })} /></Field>}
          </div>
        </div>

        {tried && problem && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] font-medium text-red-700">{problem}</p>
        )}
        <More>
          <div className="space-y-3">
            <Field label="Booking or confirmation reference"><input className="field" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
            <DetailFields defs={fields.more} d={d} set={setDet} />
            {service === "flight" && (
              <Field label="Ticket number per passenger">
                <div className="space-y-2">
                  {allTravellers.filter((t) => trav.includes(t.id)).map((t) => {
                    const mine = tickets.find((x) => isMine(x, t));
                    const cur = mine?.number ?? "";
                    // keep what the ticket already carries (issued name, source); a new number starts a new ticket
                    const put = (number: string): Ticket => ({ ...(mine && mine.number === number ? mine : {}), customer_id: t.id, passenger: t.full_name, number });
                    return (
                      <div key={t.id} className="flex items-center gap-2">
                        <span className="w-40 shrink-0 truncate text-sm">{t.full_name}</span>
                        <div className="min-w-0 flex-1">
                          <input className={cx("field font-mono", checkTicket(cur) && "!border-red-300")} value={cur} placeholder="13 digits, e.g. 098-1234567890" onChange={(e) => {
                            const rest = tickets.filter((x) => !isMine(x, t));
                            setDet("tickets", e.target.value ? [...rest, put(e.target.value)] : rest);
                          }} onBlur={(e) => {
                            const rest = tickets.filter((x) => !isMine(x, t));
                            if (e.target.value) setDet("tickets", [...rest, put(normTicket(e.target.value))]);
                          }} />
                          {checkTicket(cur) && <p className="mt-1 text-xs text-red-700">{checkTicket(cur)!.text}</p>}
                          {mine?.name_as_issued && mine.name_as_issued !== t.full_name && (
                            <p className="mt-1 text-xs text-muted">Issued as <span className="font-mono">{mine.name_as_issued}</span>. The issued name never changes; a reissue keeps the old ticket in history.</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Field>
            )}
            <Field label="Notes" hint="Internal; not shown to the client"><textarea className="field min-h-16" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            {!line && <Toggle checked={visible} onChange={setVisible} label="Visible to client" />}
          </div>
        </More>
      </div>
    </Dialog>
  );
}

function DetailFields({ defs, d, set }: { defs: FieldDef[]; d: Record<string, unknown>; set: (k: string, v: unknown) => void }) {
  if (!defs.length) return null;
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      {defs.map((f) => {
        const v = d[f.key];
        const span = f.half ? "sm:col-span-2" : "sm:col-span-4";
        if (f.type === "bool")
          return <div key={f.key} className={span}><Toggle checked={!!v} onChange={(x) => set(f.key, x)} label={f.label} /></div>;
        return (
          <Field key={f.key} label={f.label} hint={f.hint} required={f.required} className={f.type === "textarea" ? "sm:col-span-4" : span}>
            {f.type === "select" ? (
              <select className="field" value={String(v ?? "")} onChange={(e) => set(f.key, e.target.value)}>
                <option value="">—</option>{f.options!.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : f.type === "textarea" ? (
              <textarea className="field min-h-16" value={String(v ?? "")} onChange={(e) => set(f.key, e.target.value)} />
            ) : (
              <input className="field" type={f.type === "number" ? "number" : f.type ?? "text"} list={f.list ? `dl-${f.list}` : undefined}
                value={String(v ?? "")} onChange={(e) => set(f.key, f.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)} />
            )}
          </Field>
        );
      })}
    </div>
  );
}

function CancelDialog({ line, onClose }: { line: Line | null; onClose: () => void }) {
  const { me } = useApp();
  const { run, pending } = useAction();
  const [v, setV] = useState({ reason: "", cancellation_charge: "", refund_to_client: "", refund_from_supplier: "" });
  useEffect(() => { if (line) setV({ reason: "", cancellation_charge: "", refund_to_client: "", refund_from_supplier: "" }); }, [line]);
  if (!line) return null;
  const n = amount;
  const after = lineProfit({ ...line, status: "cancelled", refund_to_client: n(v.refund_to_client), refund_from_supplier: n(v.refund_from_supplier) });
  return (
    <Dialog open={!!line} onClose={onClose} title="Cancel booking"
      footer={<><Button onClick={onClose}>Keep booking</Button><Button variant="primary" className="!border-red-600 !bg-red-600" disabled={pending || !v.reason.trim()}
        onClick={() => run(() => cancelLine(line.id, { reason: v.reason, cancellation_charge: v.cancellation_charge, refund_to_client: v.refund_to_client, refund_from_supplier: v.refund_from_supplier }), { then: onClose })}>Cancel booking</Button></>}>
      <div className="space-y-3">
        <p className="text-[13px] text-muted">{SERVICE_LABEL[line.service]} {line.summary} · sold for {inr(line.selling_price)}, cost {inr(line.supplier_cost)}</p>
        <Field label="Reason" required><input className="field" autoFocus value={v.reason} onChange={(e) => setV({ ...v, reason: e.target.value })} /></Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Supplier cancellation charge (₹)">
            <input className="field tabular" inputMode="decimal" value={v.cancellation_charge}
              onChange={(e) => setV({ ...v, cancellation_charge: e.target.value, refund_from_supplier: e.target.value === "" ? v.refund_from_supplier : String(Math.max(0, Math.round((Number(line.supplier_cost) - n(e.target.value)) * 100) / 100)) })} />
          </Field>
          <Field label="Refund from supplier (₹)" hint={`Charge + refund = supplier cost ${inr(line.supplier_cost)}`}><input className="field tabular" inputMode="decimal" value={v.refund_from_supplier}
            onChange={(e) => setV({ ...v, refund_from_supplier: e.target.value, cancellation_charge: e.target.value === "" ? v.cancellation_charge : String(Math.max(0, Math.round((Number(line.supplier_cost) - n(e.target.value)) * 100) / 100)) })} /></Field>
          <Field label="Refund to client (₹)"><input className="field tabular" inputMode="decimal" value={v.refund_to_client} onChange={(e) => setV({ ...v, refund_to_client: e.target.value })} /></Field>
        </div>
        {Number(line.gst) > 0 && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
            The client also paid {inr(line.gst)} GST on this booking. It goes back to them with the refund, so they are owed{" "}
            <b>{inr(n(v.refund_to_client) + Number(line.gst))}</b> in total ({inr(n(v.refund_to_client))} refund + {inr(line.gst)} GST).
          </p>
        )}
        {me.can_see_profit && (
          <p className="rounded-lg bg-gray-50 px-3 py-2 text-[13px]">Profit after cancellation: <b className={after < 0 ? "text-red-600" : "text-emerald-700"}>{inr(after)}</b></p>
        )}
      </div>
    </Dialog>
  );
}
