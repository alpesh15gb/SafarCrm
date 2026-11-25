"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button, Field, ServiceIcon, cx } from "@/components/ui";
import { Dialog, More, useAction } from "@/components/client";
import { CustomerPicker, StaffSelect } from "@/components/pickers";
import { CustomerInline } from "./customer-inline";
import { useApp } from "@/components/shell/shell";
import { createCase } from "@/actions/cases";
import { familyMembers } from "@/actions/search";
import { LEAD_SOURCES, SERVICE_LABEL, type Service } from "@/lib/constants";

type Picked = { id: string; label: string; sub?: string };
const CASE_SERVICES: Service[] = ["flight", "hotel", "visa", "other"];

export function NewCaseForm({ onDone, preset, compact }: { onDone: (c: { id: string; max_id: string; services?: Service[] }) => void; preset?: Record<string, unknown>; compact?: boolean }) {
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
  const [assigned, setAssigned] = useState(me.id);
  const [family, setFamily] = useState<{ last_name: string | null; corporate: boolean; members: { id: string; full_name: string; relation?: string | null; designation?: string | null }[] }>({ last_name: null, corporate: false, members: [] });
  const [travellers, setTravellers] = useState<string[]>([]);
  // one key per form: a double click or a retry after a lost response returns the same MAX ID
  const [requestKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    if (!customer) { setFamily({ last_name: null, corporate: false, members: [] }); setTravellers([]); return; }
    // the customer travels by default (untick if they are only paying); a company never travels
    familyMembers(customer.id).then((f) => { setFamily(f); setTravellers(f.corporate ? [] : [customer.id]); });
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

  const submit = () =>
    run(() => createCase({ customer_id: customer?.id ?? "", title: finalTitle, destination: dest, travel_start: start, travel_end: end || null, lead_source: lead, assigned_to: assigned, traveller_ids: travellers, notes: want, services }, requestKey), {
      then: (r) => onDone({ ...(r.data as { id: string; max_id: string }), services }),
    });

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
      {customer && (
        <Field label="Who is travelling?" hint={family.corporate
          ? (family.members.length ? "Tick the employees on this trip." : "No employees saved yet. Add them on the company's Employees tab, or on the case page after creating it.")
          : "Untick the customer if they are only paying for someone else's trip."}>
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
        </Field>
      )}
      <Field label="Services" hint="Select one or more (Flight, Hotel, Visa, Other) to add to this case.">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Services">
          {CASE_SERVICES.map((s) => {
            const on = services.includes(s);
            return (
              <button
                key={s}
                type="button"
                role="checkbox"
                aria-checked={on}
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
      </Field>
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
      <div className="flex items-center justify-end gap-3">
        {customer && finalTitle && <span className="min-w-0 truncate text-xs text-muted" title={finalTitle}>Will be saved as “{finalTitle}”</span>}
        <Button variant="primary" disabled={pending || !customer || !finalTitle} onClick={submit}>Create case</Button>
      </div>
    </div>
  );
}

export function NewCaseDialog({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: Record<string, unknown> }) {
  const router = useRouter();
  return (
    <Dialog open={open} onClose={onClose} title="New case">
      {/* a fresh form each time it opens: the dialog stays on the page, and the form used to keep the customer from the
          first time (opening New case from a second customer's profile still showed the first one) */}
      {open && <NewCaseForm key={String((preset?.customer as { id?: string } | undefined)?.id ?? "none")} preset={preset}
        onDone={(c) => { onClose(); router.push(`/cases/${c.id}`); }} />}
    </Dialog>
  );
}
