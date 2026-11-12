import { FileText, Download, CalendarClock, Check, X, ListChecks } from "lucide-react";
import { Badge, Card, KV, Money, ServiceIcon, StatusBadge, cx } from "./ui";
import { DETAIL_LABELS, SERVICE_LABEL, STATUS_LABEL, VISA_STATUS_TONE, type Service } from "@/lib/constants";
import { fdate, inr } from "@/lib/format";
import { offsetLabel } from "@/lib/flight-time";

export type Trip = {
  id: string; max_id: string; title: string; status: string; travel_start: string | null; travel_end: string | null; destination: string | null;
  visible: boolean; travellers: string[]; agency: { name: string; phone: string | null; email: string | null };
  show: Record<string, boolean>;
  bookings?: { id: string; service: Service; status: string; summary: string | null; date: string | null; details: Record<string, unknown>; travellers: string[]; price: number | null }[];
  files?: { id: string; file_name: string; kind: string; created_at: string }[];
  payments?: { billed: number; paid: number; due: number };
};

const fmt = (k: string, v: unknown): string => {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (/date|check_in|check_out|until|^start|^end/.test(k) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return fdate(v);
  return String(v);
};

/** "Air India 983", or just "6E 2134" when the flight number already carries the airline code. */
export function flightLabel(airline: string | undefined, flightNo: string | undefined) {
  const a = (airline ?? "").trim(), f = (flightNo ?? "").trim();
  if (a && f.toUpperCase().replace(/[\s-]/g, "").startsWith(a.toUpperCase().replace(/[\s-]/g, ""))) return f;
  return [a, f].filter(Boolean).join(" ");
}

export function BookingDetails({ service, details }: { service: string; details: Record<string, unknown> }) {
  const d = details ?? {};
  if (service === "flight") {
    const sectors = (d.sectors as Record<string, string>[]) ?? [];
    const tickets = (d.tickets as Record<string, string>[]) ?? [];
    return (
      <div className="space-y-3">
        {sectors.length > 0 && (
          <div className="space-y-1.5">
            {sectors.map((s, i) => (
              <div key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 rounded-lg bg-gray-50 px-3 py-2">
                <span className="font-semibold">{s.from} → {s.to}</span>
                <span>{fdate(s.date)}</span>
                <span className="text-muted">{flightLabel(s.airline, s.flight_no)}</span>
                {(s.dep || s.arr) && (
                  <span className="text-muted">
                    {s.dep}{s.arr && ` – ${s.arr}`}
                    {/* the day shift comes only from a recorded arrival date, never from comparing the two times */}
                    {s.arr && offsetLabel(s) ? <sup className="ml-0.5 font-semibold text-coral-dark" title={`Lands ${fdate(s.arr_date)}`}>{offsetLabel(s)}</sup> : null}
                    {s.arr_date && s.arr_date !== s.date && <span className="ml-1 text-xs">(arrives {fdate(s.arr_date)})</span>}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        <KV cols={3} items={[["Airline PNR", d.pnr as string], ["Cabin", d.cabin as string], ["Baggage", d.baggage as string],
          ["Trip type", d.trip_type as string], ["Refundable", d.refundable === undefined ? "" : d.refundable ? "Yes" : "No"],
          ...(d.supplier_ref ? [["Supplier/GDS ref", d.supplier_ref as string] as [string, string]] : [])]} />
        {tickets.length > 0 && (
          <div className="text-sm">
            <div className="mb-1 text-xs text-muted">Ticket numbers</div>
            {tickets.map((t, i) => (
              <div key={i}>
                {t.name_as_issued || t.passenger}: <span className="font-mono">{t.number}</span>
                {t.name_as_issued && t.passenger && t.name_as_issued !== t.passenger && <span className="ml-1 text-xs text-muted">(profile name: {t.passenger})</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (service === "visa") return <VisaDetails d={d} />;
  const skip = new Set(["sectors", "tickets"]);
  return <KV cols={3} items={Object.entries(d).filter(([k]) => !skip.has(k)).map(([k, v]) => [DETAIL_LABELS[k] ?? (k === "nights" ? "Nights" : k), fmt(k, v)])} />;
}

const VISA_TRACK = ["Documents", "Applied", "Processing", "Decision"];
function visaStep(st: string) {
  if (["Approved", "Rejected", "Passport collected"].includes(st)) return 3;
  if (["Biometrics done", "Under process"].includes(st)) return 2;
  if (["Applied", "Appointment booked"].includes(st)) return 1;
  return 0;
}

/** Client-facing visa view: where it stands, the appointment, and which documents we still need. */
function VisaDetails({ d }: { d: Record<string, unknown> }) {
  const st = (d.application_status as string) || "Documents pending";
  const at = visaStep(st);
  const rejected = st === "Rejected";
  const s = (k: string) => (d[k] as string) || "";
  const list: { item: string; done: boolean }[] = Array.isArray(d.checklist)
    ? (d.checklist as { item: string; done: boolean }[])
    : s("documents").split(/\n+/).map((x) => x.replace(/^[-•*\s]+/, "").trim()).filter(Boolean).map((item) => ({ item, done: false }));
  const missing = list.filter((c) => !c.done).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge dot tone={VISA_STATUS_TONE[st] ?? "grey"}>{rejected ? "Refused" : st}</Badge>
        <ol className="flex min-w-[260px] flex-1 items-center">
          {VISA_TRACK.map((label, i) => {
            const done = i < at || (i === at && at === 3 && !rejected);
            const cur = i === at;
            return (
              <li key={label} className={cx("flex items-center", i < VISA_TRACK.length - 1 && "flex-1")}>
                <span className="flex items-center gap-1.5">
                  <span className={cx("flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold",
                    cur && rejected ? "bg-red-500 text-white" : done ? "bg-emerald-500 text-white" : cur ? "bg-coral text-white" : "bg-gray-100 text-gray-400")}>
                    {cur && rejected ? <X className="h-3 w-3" /> : done ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  <span className={cx("whitespace-nowrap text-xs", cur ? "font-semibold" : "text-muted")}>{label}</span>
                </span>
                {i < VISA_TRACK.length - 1 && <span className={cx("mx-2 h-0.5 min-w-4 flex-1 rounded-full", i < at ? "bg-emerald-400" : "bg-gray-200")} />}
              </li>
            );
          })}
        </ol>
      </div>
      {d.passport_with_us === true && <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">Your passport is safely with us. We will return it after the decision.</p>}
      {s("appointment_date") && (
        <div className="flex items-center gap-3 rounded-xl bg-sky-50 px-3 py-2.5 text-sm text-sky-900 ring-1 ring-inset ring-sky-100">
          <CalendarClock className="h-4 w-4 shrink-0 text-sky-600" />
          <span>Your appointment: <b>{fdate(s("appointment_date"))}{s("appointment_time") && ` at ${s("appointment_time")}`}</b>{s("appointment_center") && ` · ${s("appointment_center")}`}. Carry your original passport and the documents below.</span>
        </div>
      )}
      <KV cols={3} items={[
        ["Country", s("country")], ["Visa type", s("visa_type")], ["Application no.", s("application_no")],
        ["Visa number", s("visa_number")],
        ["Valid", s("valid_to") ? `${s("valid_from") ? fdate(s("valid_from")) : "…"} → ${fdate(s("valid_to"))}` : ""],
        ["Stay allowed", s("stay_days") ? `${s("stay_days")} days` : ""],
      ]} />
      {list.length > 0 && !["Approved", "Passport collected"].includes(st) && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted">
            <ListChecks className="h-3.5 w-3.5" />{missing ? `Documents we need from you (${missing} still pending)` : "All documents received. Thank you!"}
          </div>
          <ul className="grid gap-1 sm:grid-cols-2">
            {list.map((c, i) => (
              <li key={i} className={cx("flex items-start gap-2 text-sm", c.done && "text-muted")}>
                <span className={cx("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full", c.done ? "bg-emerald-500 text-white" : "border border-gray-300")}>{c.done && <Check className="h-3 w-3" />}</span>
                {c.item}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function TripView({ trip, fileHref }: { trip: Trip; fileHref: (id: string) => string }) {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="font-mono text-sm font-semibold">{trip.max_id}</div>
            <div className="text-lg font-semibold">{trip.title}</div>
            <div className="text-[13px] text-muted">
              {trip.travel_start && `${fdate(trip.travel_start)}${trip.travel_end ? " → " + fdate(trip.travel_end) : ""}`}
              {trip.destination && ` · ${trip.destination}`}
            </div>
            {trip.travellers?.length > 0 && <div className="mt-1 text-[13px]">Travellers: {trip.travellers.join(", ")}</div>}
          </div>
          <StatusBadge status={trip.status} />
        </div>
      </Card>
      {trip.bookings && (
        <div className="space-y-3">
          {trip.bookings.length === 0 && <Card><p className="text-muted">Booking details will appear here once confirmed.</p></Card>}
          {trip.bookings.map((b) => (
            <Card key={b.id} title={<span className="flex items-center gap-2"><ServiceIcon service={b.service} />{SERVICE_LABEL[b.service]}{b.summary && <span className="font-normal text-muted">· {b.summary}</span>}</span>}
              action={<span className="flex items-center gap-2">{b.price !== null && b.price !== undefined && <span className="tabular text-sm">{inr(b.price)}</span>}<Badge tone={b.status === "confirmed" ? "green" : b.status === "cancelled" ? "red" : "grey"}>{STATUS_LABEL[b.status]}</Badge></span>}>
              <BookingDetails service={b.service} details={b.details} />
              {b.travellers.length > 0 && <div className="mt-3 text-xs text-muted">For: {b.travellers.join(", ")}</div>}
            </Card>
          ))}
        </div>
      )}
      {trip.files && trip.files.length > 0 && (
        <Card title="Tickets and documents" pad={false}>
          <ul>
            {trip.files.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5 last:border-0">
                <span className="flex min-w-0 items-center gap-2"><FileText className="h-4 w-4 shrink-0 text-muted" /><span className="truncate">{f.file_name}</span></span>
                <a href={fileHref(f.id)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm link"><Download className="h-4 w-4" />Download</a>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {trip.payments && (
        <Card title="Payment summary">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div><div className="text-xs text-muted">Total</div><Money value={trip.payments.billed} className="font-semibold" /></div>
            <div><div className="text-xs text-muted">Paid</div><Money value={trip.payments.paid} className="font-semibold text-emerald-700" /></div>
            {Number(trip.payments.due) < 0
              ? <div><div className="text-xs text-muted">Your credit</div><Money value={-Number(trip.payments.due)} className="font-semibold text-sky-700" /><div className="text-[11px] text-muted">Due ₹0</div></div>
              : <div><div className="text-xs text-muted">Due</div><Money value={trip.payments.due} className={Number(trip.payments.due) > 0 ? "font-semibold text-amber-700" : "font-semibold"} /></div>}
          </div>
        </Card>
      )}
      <p className="text-center text-xs text-muted">
        Questions? Contact {trip.agency.name}{trip.agency.phone && ` · ${trip.agency.phone}`}{trip.agency.email && ` · ${trip.agency.email}`}. Please quote {trip.max_id}.
      </p>
    </div>
  );
}
