"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Field } from "@/components/ui";
import { Dialog, More, useAction } from "@/components/client";
import { CustomerPicker, StaffSelect } from "@/components/pickers";
import { CustomerInline } from "./customer-inline";
import { useApp } from "@/components/shell/shell";
import { createCase } from "@/actions/cases";
import { familyMembers } from "@/actions/search";
import { LEAD_SOURCES } from "@/lib/constants";

type Picked = { id: string; label: string; sub?: string };

export function NewCaseForm({ onDone, preset, compact }: { onDone: (c: { id: string; max_id: string }) => void; preset?: Record<string, unknown>; compact?: boolean }) {
  const { me, staff } = useApp();
  const { run, pending } = useAction();
  const [customer, setCustomer] = useState<Picked | null>((preset?.customer as Picked) ?? null);
  const [adding, setAdding] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [dest, setDest] = useState("");
  const [from, setFrom] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [lead, setLead] = useState("");
  const [assigned, setAssigned] = useState(me.id);
  const [family, setFamily] = useState<{ last_name: string | null; members: { id: string; full_name: string }[] }>({ last_name: null, members: [] });
  const [travellers, setTravellers] = useState<string[]>([]);

  useEffect(() => {
    if (!customer) { setFamily({ last_name: null, members: [] }); setTravellers([]); return; }
    familyMembers(customer.id).then((f) => { setFamily(f); setTravellers([]); });
  }, [customer]);

  useEffect(() => {
    if (titleTouched || !customer) return;
    const who = family.members.length && family.last_name ? `${family.last_name} family` : customer.label;
    const route = from && dest ? `${from} to ${dest}` : dest || "";
    setTitle(route ? `${route}, ${who}` : `Trip for ${who}`);
  }, [customer, dest, from, family, titleTouched]);

  const submit = () =>
    run(() => createCase({ customer_id: customer?.id ?? "", title, destination: dest, travel_start: start, travel_end: end || null, lead_source: lead, assigned_to: assigned, traveller_ids: travellers }), {
      then: (r) => onDone(r.data as { id: string; max_id: string }),
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
      {family.members.length > 0 && (
        <Field label="Who is travelling?">
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            <label className="flex items-center gap-1.5 text-sm text-muted"><input type="checkbox" checked disabled /> {customer?.label}</label>
            {family.members.map((m) => (
              <label key={m.id} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={travellers.includes(m.id)} onChange={(e) => setTravellers((t) => (e.target.checked ? [...t, m.id] : t.filter((x) => x !== m.id)))} />
                {m.full_name}
              </label>
            ))}
          </div>
        </Field>
      )}
      <Field label="Title" required hint="Suggested from the customer and destination; change it if you like.">
        <input className="field" value={title} onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }} />
      </Field>
      <More title="More details (dates, destination, staff)" defaultOpen={!compact}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From"><input className="field" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Delhi" /></Field>
          <Field label="Destination"><input className="field" value={dest} onChange={(e) => setDest(e.target.value)} placeholder="Goa" /></Field>
          <Field label="Travel start"><input type="date" className="field" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Travel end"><input type="date" className="field" min={start} value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
          <Field label="Lead source">
            <select className="field" value={lead} onChange={(e) => setLead(e.target.value)}>
              <option value="">—</option>
              {LEAD_SOURCES.map((l) => <option key={l}>{l}</option>)}
            </select>
          </Field>
          <Field label="Assigned to"><StaffSelect staff={staff} value={assigned} onChange={setAssigned} /></Field>
        </div>
      </More>
      <div className="flex justify-end">
        <Button variant="primary" disabled={pending || !customer || !title.trim()} onClick={submit}>Create MAX ID</Button>
      </div>
    </div>
  );
}

export function NewCaseDialog({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: Record<string, unknown> }) {
  const router = useRouter();
  return (
    <Dialog open={open} onClose={onClose} title="New case">
      <NewCaseForm preset={preset} onDone={(c) => { onClose(); router.push(`/cases/${c.id}`); }} />
    </Dialog>
  );
}
