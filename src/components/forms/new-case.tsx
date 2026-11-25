"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button, Field, ServiceIcon, cx } from "@/components/ui";
import { Dialog, More, useAction } from "@/components/client";
import { CustomerPicker, StaffSelect } from "@/components/pickers";
import { CustomerInline } from "./customer-inline";
import { BookingDetailsFields } from "./booking-details-fields";
import { BookingPriceFields, EMPTY_BOOKING_PRICE } from "./booking-price-fields";
import { TicketPick } from "./ticket-pick";
import { useApp } from "@/components/shell/shell";
import { createCase, type CaseCreation } from "@/actions/cases";
import { confirmLine } from "@/actions/bookings";
import { familyMembers } from "@/actions/search";
import { DEFAULT_KIND, LEAD_SOURCES, SERVICES, SERVICE_LABEL, type Service } from "@/lib/constants";
import type { BookingPrice } from "@/lib/money";

type Picked = { id: string; label: string; sub?: string };
const ATTACH_LABEL: Record<Service, string> = {
  flight: "Attach ticket", hotel: "Attach voucher", visa: "Attach visa document", insurance: "Attach policy",
  rail: "Attach ticket", bus: "Attach ticket", other: "Attach document",
};
type Upload = CaseCreation["bookings"][number] & { file: File | null; key: string; attached?: boolean; error?: string };

const confirmsWithFile = (service: Service) => ["ticket", "voucher", "policy"].includes(DEFAULT_KIND[service]);

async function finishUpload(caseId: string, upload: Upload): Promise<Upload> {
  if (!upload.file) return upload;
  let attached = upload.attached;
  try {
    if (!attached) {
      const body = new FormData();
      body.set("target", "line");
      body.set("case_id", caseId);
      body.set("line_id", upload.id);
      body.set("kind", DEFAULT_KIND[upload.service]);
      body.set("file", upload.file);
      body.set("upload_id", upload.key);
      const response = await fetch("/api/upload", { method: "POST", body });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        return { ...upload, error: result.error || "The file could not be uploaded." };
      }
      attached = true;
    }
    if (confirmsWithFile(upload.service)) {
      const result = await confirmLine(upload.id);
      if (!result.ok) return { ...upload, attached, error: `File attached. ${result.error}` };
    }
    return { ...upload, attached, error: undefined };
  } catch {
    return { ...upload, attached, error: attached ? "File attached. Booking confirmation failed. Try again." : "Upload interrupted. Try again." };
  }
}

export function NewCaseForm({ onDone, onSavingChange, preset, compact }: {
  onDone: (c: CaseCreation) => void; onSavingChange?: (saving: boolean) => void; preset?: Record<string, unknown>; compact?: boolean;
}) {
  const { me, staff } = useApp();
  const { run, pending } = useAction();
  const [customer, setCustomer] = useState<Picked | null>((preset?.customer as Picked) ?? null);
  const [adding, setAdding] = useState<string | null>(null);
  // the suggested title is shown in the empty box; whatever is typed replaces it whole (QA, 2026-11-18: typing used to
  // land next to the suggestion and both were saved run together)
  const [title, setTitle] = useState("");
  const [dest, setDest] = useState("");
  const [from, setFrom] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [lead, setLead] = useState("");
  const [want, setWant] = useState("");
  const [services, setServices] = useState<Service[]>([]);
  const [details, setDetails] = useState<Partial<Record<Service, Record<string, unknown>>>>({});
  const [prices, setPrices] = useState<Partial<Record<Service, BookingPrice<string>>>>({});
  const [files, setFiles] = useState<Partial<Record<Service, File | null>>>({});
  const [fileErrors, setFileErrors] = useState<Partial<Record<Service, string>>>({});
  const [created, setCreated] = useState<CaseCreation | null>(null);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [formError, setFormError] = useState("");
  const saving = useRef(false);
  const [assigned, setAssigned] = useState(me.id);
  const [family, setFamily] = useState<{ last_name: string | null; corporate: boolean; members: { id: string; full_name: string; relation?: string | null; designation?: string | null }[] }>({ last_name: null, corporate: false, members: [] });
  const [travellers, setTravellers] = useState<string[]>([]);
  const [familyFor, setFamilyFor] = useState<string>();
  // one key per form: a double click or a retry after a lost response returns the same MAX ID
  const [requestKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!customer) return;
    // the customer travels by default (untick if they are only paying); a company never travels
    let current = true;
    familyMembers(customer.id).then((f) => {
      if (current) { setFamily(f); setTravellers(f.corporate ? [] : [customer.id]); setFamilyFor(customer.id); }
    }).catch(() => { if (current) setFormError("Could not load travellers. Select the customer again to retry."); });
    return () => { current = false; };
  }, [customer]);
  const tick = (id: string, on: boolean) => setTravellers((t) => (on ? [...t, id] : t.filter((x) => x !== id)));
  const toggleService = (s: Service) => setServices((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const suggested = (() => {
    if (!customer) return "";
    const who = !family.corporate && family.members.length && family.last_name ? `${family.last_name} family` : customer.label;
    const route = from && dest ? `${from} to ${dest}` : dest || "";
    const svc = services.length ? services.map((s) => SERVICE_LABEL[s]).join(" + ") : "";
    if (route && svc) return `${svc} · ${route}, ${who}`;
    if (route) return `${route}, ${who}`;
    if (svc) return `${svc} for ${who}`;
    return `Trip for ${who}`;
  })();
  const finalTitle = title.trim() || suggested;

  const submit = async () => {
    if (saving.current) return;
    saving.current = true;
    onSavingChange?.(true);
    setFormError("");
    try {
      await run(async () => {
        let kase = created;
        let queue = uploads;
        if (!kase) {
          const result = await createCase({
            customer_id: customer?.id ?? "", title: finalTitle, destination: dest, travel_start: start, travel_end: end || null,
            lead_source: lead, assigned_to: assigned, traveller_ids: travellers, notes: want,
            bookings: services.map((service) => ({ service, details: details[service] ?? {}, pricing: prices[service] })),
          }, requestKey);
          if (!result.ok) { setFormError(result.error); return result; }
          if (!result.data) return { ok: false as const, error: "The case could not be opened. Try again." };
          kase = result.data;
          queue = kase.bookings.flatMap((line) => {
            const file = files[line.service];
            return file ? [{ ...line, file, key: crypto.randomUUID() }] : [];
          });
          setCreated(kase);
          setUploads(queue);
        }
        // Upload in order so multiple attachments on a case get distinct file names.
        const remaining: Upload[] = [];
        for (const upload of queue) {
          const result = await finishUpload(kase.id, upload);
          if (result.error) remaining.push(result);
        }
        setUploads(remaining);
        return remaining.length
          ? { ok: false as const, error: `${kase.max_id} created. Check the attachments below.` }
          : { ok: true as const, data: kase, message: `${kase.max_id} created` };
      }, { refresh: false, then: (r) => { if (r.data) onDone(r.data); } });
    } finally {
      saving.current = false;
      onSavingChange?.(false);
    }
  };

  if (created) return (
    <div className="space-y-4">
      <p className="text-sm font-medium">{created.max_id} created</p>
      {pending ? <p role="status" className="text-sm text-muted">Attaching files…</p> : <>
        {uploads.map((upload) => (
          <div key={upload.id} className="space-y-2 rounded-lg border border-line p-3">
            <p className="text-sm font-medium">{SERVICE_LABEL[upload.service]}</p>
            {upload.attached ? <p className="text-sm text-muted">{upload.file?.name} attached</p> : (
              <TicketPick file={upload.file} onPick={(file, error) => setUploads((items) => items.map((item) => item.id === upload.id
                ? { ...item, file, key: file === item.file ? item.key : crypto.randomUUID(), error }
                : item))} />
            )}
            {upload.error && <p role="alert" className="text-sm text-red-700">{upload.error}</p>}
          </div>
        ))}
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={() => onDone(created)}>Open case</Button>
          {uploads.some((upload) => upload.file) && <Button variant="primary" onClick={submit}>Retry attachments</Button>}
        </div>
      </>}
    </div>
  );

  return (
    <div className="space-y-4">
      <Field label="Customer" required>
        {adding !== null ? (
          <CustomerInline initialName={adding} onCancel={() => setAdding(null)} onCreated={(c) => { setCustomer({ id: c.id, label: c.full_name }); setAdding(null); }} />
        ) : (
          <CustomerPicker
            value={customer}
            onChange={setCustomer}
            autoFocus={!preset?.customer}
            footer={(q, close) => (
              <button type="button" className="w-full rounded px-2 py-1.5 text-left text-sm link" onClick={() => { setAdding(q); close(); }}>
                + Add new customer{q ? ` “${q}”` : ""}
              </button>
            )}
          />
        )}
      </Field>
      {customer && familyFor === customer.id && (
        <fieldset>
          <legend className="mb-1 text-[13px] font-medium text-ink">Who is travelling?</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {!family.corporate && (
              <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={travellers.includes(customer.id)} onChange={(e) => tick(customer.id, e.target.checked)} />{customer.label}</label>
            )}
            {family.members.map((m) => (
              <label key={m.id} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={travellers.includes(m.id)} onChange={(e) => tick(m.id, e.target.checked)} />
                {m.full_name}{(m.relation || m.designation) && <span className="text-xs text-muted">· {m.relation || m.designation}</span>}
              </label>
            ))}
          </div>
          <p className="mt-1 text-xs text-muted">{family.corporate
            ? (family.members.length ? "Tick the employees on this trip." : "No employees saved yet. Add them on the company's Employees tab, or on the case page after creating it.")
            : "Untick the customer if they are only paying for someone else's trip."}</p>
        </fieldset>
      )}
      <fieldset>
        <legend className="mb-1 text-[13px] font-medium text-ink">Services</legend>
        <p className="mb-2 text-xs text-muted">Select the services for this case. You can add the file or details now or later.</p>
        <div className="flex flex-wrap gap-2">
          {SERVICES.map((s) => {
            const on = services.includes(s);
            return (
              <button
                key={s}
                type="button"
                role="checkbox"
                aria-checked={on}
                aria-label={SERVICE_LABEL[s]}
                onClick={() => toggleService(s)}
                className={cx(
                  "inline-flex items-center gap-2 rounded-[10px] border px-3.5 py-2 text-sm font-medium transition-all",
                  on
                    ? "border-coral bg-coral-soft text-coral-dark ring-1 ring-coral/30"
                    : "border-line bg-white text-ink hover:border-gray-300 hover:bg-gray-50",
                )}
              >
                <ServiceIcon service={s} className="h-4 w-4" />
                {SERVICE_LABEL[s]}
                {on && <Check className="h-3.5 w-3.5 text-coral-dark" />}
              </button>
            );
          })}
        </div>
      </fieldset>
      {services.map((service) => (
        <section key={service} aria-label={`${SERVICE_LABEL[service]} booking`} className="space-y-3 rounded-xl border border-line p-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold"><ServiceIcon service={service} />{SERVICE_LABEL[service]} booking</h3>
          <div className="space-y-1">
            <p className="text-[13px] font-medium">{ATTACH_LABEL[service]}</p>
            <TicketPick file={files[service] ?? null} onPick={(file, error) => {
              setFiles((f) => ({ ...f, [service]: file }));
              setFileErrors((errors) => ({ ...errors, [service]: error }));
            }} />
            {fileErrors[service] ? <p role="alert" className="text-xs text-red-700">
              {fileErrors[service]} <button type="button" className="underline" onClick={() => setFileErrors((errors) => ({ ...errors, [service]: "" }))}>Dismiss</button>
            </p> : (
              <p className="text-xs text-muted">PDF, JPG or PNG up to 10 MB.{files[service] && confirmsWithFile(service) ? " Attaching this file marks the booking Confirmed." : ""}</p>
            )}
          </div>
          <More title="Enter details">
            <BookingDetailsFields service={service} details={details[service] ?? {}}
              onChange={(value) => setDetails((d) => ({ ...d, [service]: value }))} />
          </More>
          <div className="rounded-lg border border-line p-3">
            <BookingPriceFields visa={service === "visa"} perPerson={service === "visa" && travellers.length > 1}
              showCommission={me.can_see_profit} price={prices[service] ?? EMPTY_BOOKING_PRICE}
              onChange={(value) => setPrices((p) => ({ ...p, [service]: value }))} />
          </div>
        </section>
      ))}
      <Field label="What does the client want?" hint="Number of people, budget, hotel type: whatever they said. Saved in the case notes.">
        <textarea className="field min-h-16" value={want} onChange={(e) => setWant(e.target.value)} placeholder="4 adults, beach hotel, budget about 80,000" />
      </Field>
      {!compact && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Going to"><input className="field" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="Goa" /></Field>
          <Field label="From date"><input type="date" className="field" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="To date"><input type="date" className="field" min={start} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        </div>
      )}
      {/* filled in for you or rarely changed: the title is suggested, the case goes to you */}
      <More title={`More: title, starting city, lead source, owner${compact ? ", dates" : ""}`}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Title" required hint="Leave empty to use the suggestion shown, or type your own.">
              <input className="field" value={title} placeholder={suggested} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          </div>
          <Field label="Starting from"><input className="field" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Delhi" /></Field>
          {compact && <Field label="Going to"><input className="field" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="Goa" /></Field>}
          {compact && <Field label="From date"><input type="date" className="field" value={start} onChange={(e) => setStart(e.target.value)} /></Field>}
          {compact && <Field label="To date"><input type="date" className="field" min={start} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>}
          <Field label="Lead source">
            <select className="field" value={lead} onChange={(e) => setLead(e.target.value)}>
              <option value="">—</option>
              {LEAD_SOURCES.map((l) => <option key={l}>{l}</option>)}
            </select>
          </Field>
          <Field label="Owner"><StaffSelect staff={staff} value={assigned} onChange={setAssigned} /></Field>
        </div>
      </More>
      {formError && <p role="alert" className="text-sm text-red-700">{formError}</p>}
      <div className="flex items-center justify-end gap-3">
        {customer && finalTitle && <span className="min-w-0 truncate text-xs text-muted" title={finalTitle}>Will be saved as “{finalTitle}”</span>}
        <Button variant="primary" disabled={pending || !customer || familyFor !== customer.id || !finalTitle || services.some((service) => fileErrors[service])} onClick={submit}>{pending ? "Creating case…" : "Create case"}</Button>
      </div>
    </div>
  );
}

export function NewCaseDialog({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: Record<string, unknown> }) {
  const router = useRouter();
  const busy = useRef(false);
  return (
    <Dialog open={open} onClose={() => { if (!busy.current) onClose(); }} title="New case" wide>
      {/* a fresh form each time it opens: the dialog stays on the page, and the form used to keep the customer from the
          first time (opening New case from a second customer's profile still showed the first one) */}
      {open && <NewCaseForm key={String((preset?.customer as { id?: string } | undefined)?.id ?? "none")} preset={preset}
        onSavingChange={(saving) => { busy.current = saving; }}
        onDone={(c) => { onClose(); router.push(`/cases/${c.id}${c.bookings.length ? "?tab=bookings" : ""}`); }} />}
    </Dialog>
  );
}
