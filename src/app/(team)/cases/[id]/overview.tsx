"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Eye, Pencil, UserPlus } from "lucide-react";
import { Badge, Button, Card, Field, KV, ServiceIcon, StatusBadge } from "@/components/ui";
import { Dialog, Toggle, useAction } from "@/components/client";
import { CustomerPicker } from "@/components/pickers";
import { useApp } from "@/components/shell/shell";
import { TripView, type Trip } from "@/components/trip-view";
import { PersonDialog } from "@/components/person-dialog";
import { previewAsClient, setClientView, setTravellers, updateCase } from "@/actions/cases";
import { familyMembers } from "@/actions/search";
import { LEAD_SOURCES, SERVICE_LABEL } from "@/lib/constants";
import { age, expiryLabel, fdate } from "@/lib/format";
import { tripDatesProblem } from "@/lib/validate";
import type { Line } from "./bookings";

type Kase = {
  id: string; max_id: string; title: string; travel_start: string | null; travel_end: string | null; destination: string | null;
  lead_source: string | null; notes: string | null; tags: string[]; status: string; client_view: Record<string, boolean> | null;
  is_international: boolean;
};
type Trav = { id: string; full_name: string; dob: string | null; passport_expiry: string | null };
type Cust = { id: string; full_name: string; family_id: string | null; mobile: string; customer_type: string };

const VIEW_SWITCHES: [string, string, boolean][] = [
  ["show_case", "Show case in portal", true],
  ["show_bookings", "Show booking details", true],
  ["show_files", "Show tickets and files", true],
  ["show_payments", "Show payment summary", true],
  ["show_line_prices", "Show price per line (otherwise total only)", false],
];

export function OverviewTab({ kase, customer, travellers, lines }: { kase: Kase; customer: Cust; travellers: Trav[]; lines: Line[] }) {
  const { me } = useApp();
  const { run, pending } = useAction();
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState(kase);
  const [preview, setPreview] = useState<Trip | null | "loading">(null);
  useEffect(() => setF(kase), [kase]);
  const set = (k: keyof Kase, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const view = { show_case: true, show_bookings: true, show_files: true, show_payments: true, show_line_prices: false, ...(kase.client_view ?? {}) };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        <Card title="Case details" action={!edit && <Button size="sm" onClick={() => setEdit(true)}>Edit</Button>}>
          {edit ? (
            <div className="space-y-3">
              <Field label="Title" required><input className="field" value={f.title} onChange={(e) => set("title", e.target.value)} /></Field>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Travel start"><input type="date" className="field" value={f.travel_start ?? ""} onChange={(e) => set("travel_start", e.target.value)} /></Field>
                <Field label="Travel end"><input type="date" className="field" value={f.travel_end ?? ""} onChange={(e) => set("travel_end", e.target.value)} /></Field>
                <Field label="Destination"><input className="field" value={f.destination ?? ""} onChange={(e) => set("destination", e.target.value)} /></Field>
                <Field label="Lead source">
                  <select className="field" value={f.lead_source ?? ""} onChange={(e) => set("lead_source", e.target.value)}>
                    <option value="">—</option>{LEAD_SOURCES.map((l) => <option key={l}>{l}</option>)}
                  </select>
                </Field>
                <Field label="Tags" className="sm:col-span-2" hint="Comma separated">
                  <input className="field" value={f.tags.join(", ")} onChange={(e) => set("tags", e.target.value.split(",").map((t) => t.trim()).filter(Boolean))} />
                </Field>
              </div>
              {tripDatesProblem(f.travel_start, f.travel_end) && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-[13px] font-medium text-red-700">{tripDatesProblem(f.travel_start, f.travel_end)}</p>}
              <Field label="Internal notes" hint="Never shown to the client"><textarea className="field min-h-20" value={f.notes ?? ""} onChange={(e) => set("notes", e.target.value)} /></Field>
              <div className="flex justify-end gap-2">
                <Button onClick={() => { setF(kase); setEdit(false); }}>Cancel</Button>
                <Button variant="primary" disabled={pending || !!tripDatesProblem(f.travel_start, f.travel_end)} onClick={() => run(() => updateCase(kase.id, f), { then: () => setEdit(false) })}>Save</Button>
              </div>
            </div>
          ) : (
            <KV cols={3} items={[
              ["Travel", kase.travel_start ? `${fdate(kase.travel_start)}${kase.travel_end ? " → " + fdate(kase.travel_end) : ""}` : ""],
              ["Destination", kase.destination],
              ["Lead source", kase.lead_source],
              ["Tags", kase.tags.length ? <span className="flex flex-wrap gap-1">{kase.tags.map((t) => <Badge key={t}>{t}</Badge>)}</span> : ""],
              ["International", kase.is_international ? "Yes" : ""],
              ["Internal notes", kase.notes ? <span className="whitespace-pre-wrap">{kase.notes}</span> : ""],
            ]} />
          )}
        </Card>

        <Card title="Bookings" pad={false} action={
          <span className="flex items-center gap-3">
            <Link className="text-sm link" href={`/cases/${kase.id}?tab=bookings`}>Open bookings</Link>
          </span>}>
          {lines.length === 0 ? (
            <p className="p-4 text-muted">No bookings yet. <Link className="link" href={`/cases/${kase.id}?tab=bookings`}>Add a flight, hotel or other service.</Link></p>
          ) : (
            <ul>
              {lines.map((l) => (
                <li key={l.id} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
                  <ServiceIcon service={l.service} className="h-4 w-4 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{SERVICE_LABEL[l.service]}{l.summary && ` · ${l.summary}`}</span>
                  <span className="text-xs text-muted">{fdate(l.service_date)}</span>
                  <StatusBadge status={l.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="min-w-0 space-y-4">
        <TravellersCard caseId={kase.id} customer={customer} travellers={travellers} />
        <Card
          title="Client view"
          action={<Button size="sm" onClick={async () => { setPreview("loading"); setPreview(await previewAsClient(kase.id)); }}><Eye className="h-4 w-4" />Preview as client</Button>}
        >
          {/* five switches most people never touch: staff get one line, the boss opens them when needed */}
          {me.role !== "boss" ? (
            <p className="text-[13px] text-muted">The boss decides what the client sees. Use the preview to check.</p>
          ) : (
            <details className="group">
              <summary className="cursor-pointer select-none list-none text-[13px] font-medium text-muted hover:text-ink">
                <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span> Choose what the client sees
              </summary>
              <div className="mt-3 space-y-2.5">
                {VIEW_SWITCHES.map(([k, label]) => (
                  <Toggle
                    key={k}
                    label={label}
                    checked={!!view[k as keyof typeof view]}
                    disabled={pending}
                    onChange={(v) => run(() => setClientView(kase.id, { ...view, [k]: v }))}
                  />
                ))}
              </div>
            </details>
          )}
        </Card>
      </div>

      <Dialog open={preview !== null} onClose={() => setPreview(null)} title="Preview: what the client sees" wide>
        {preview === "loading" && <p className="text-muted">Loading…</p>}
        {preview && preview !== "loading" && (
          <div className="rounded-lg bg-page p-3">
            {!preview.visible && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">This case is currently hidden from the client portal.</p>}
            <TripView trip={preview} fileHref={(id) => `/api/files/${id}`} />
          </div>
        )}
      </Dialog>
    </div>
  );
}

function TravellersCard({ caseId, customer, travellers }: { caseId: string; customer: Cust; travellers: Trav[] }) {
  const { run, pending } = useAction();
  const [edit, setEdit] = useState(false);
  const [members, setMembers] = useState<{ id: string; full_name: string; relation?: string | null; designation?: string | null }[]>([]);
  const [corporate, setCorporate] = useState(customer.customer_type === "corporate");
  const [sel, setSel] = useState<string[]>(travellers.map((t) => t.id));
  const [extra, setExtra] = useState<{ id: string; full_name: string }[]>([]);
  const [person, setPerson] = useState<{ id?: string } | null>(null);

  useEffect(() => {
    if (!edit) return;
    familyMembers(customer.id).then((f) => { setMembers(f.members); setCorporate(f.corporate); });
    setSel(travellers.map((t) => t.id));
    setExtra(travellers.filter((t) => t.id !== customer.id));
  }, [edit, customer.id, travellers]);

  const options = [
    ...(corporate ? [] : [{ id: customer.id, full_name: customer.full_name, note: "customer" }]),
    ...members.map((m) => ({ id: m.id, full_name: m.full_name, note: m.relation || m.designation || "" })),
    ...extra.filter((e) => e.id !== customer.id && !members.some((m) => m.id === e.id)).map((e) => ({ ...e, note: "" })),
  ];
  const toggle = (id: string, on: boolean) => setSel((s) => (on ? [...new Set([...s, id])] : s.filter((x) => x !== id)));

  return (
    <Card title={`Travellers (${travellers.length})`} action={!edit && <Button size="sm" onClick={() => setEdit(true)}>Change</Button>}>
      {edit ? (
        <div className="space-y-3">
          {options.map((m) => (
            <label key={m.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={sel.includes(m.id)} onChange={(e) => toggle(m.id, e.target.checked)} />
              {m.full_name}{m.note && <span className="text-xs text-muted">· {m.note}</span>}
            </label>
          ))}
          {!corporate && <p className="text-xs text-muted">Untick {customer.full_name} if they are only paying for this trip.</p>}
          <Field label="Add a customer already on file">
            <CustomerPicker value={null} onChange={(o) => { if (o) { setExtra((x) => [...x, { id: o.id, full_name: o.label }]); toggle(o.id, true); } }} />
          </Field>
          <Button size="sm" onClick={() => setPerson({})}><UserPlus className="h-3.5 w-3.5" />New traveller</Button>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={() => setEdit(false)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={pending} onClick={() => run(() => setTravellers(caseId, sel), { then: () => setEdit(false) })}>Save</Button>
          </div>
        </div>
      ) : travellers.length === 0 ? (
        <div className="space-y-2 text-sm text-muted">
          <p>No travellers yet. Bookings need at least one.</p>
          <Button size="sm" variant="primary" onClick={() => setEdit(true)}>Add travellers</Button>
        </div>
      ) : (
        <ul className="space-y-2">
          {travellers.map((t) => {
            const exp = expiryLabel(t.passport_expiry);
            const a = age(t.dob);
            return (
              <li key={t.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5">
                  <Link href={`/customers/${t.id}`} className="link">{t.full_name}</Link>
                  <button type="button" aria-label={`Edit ${t.full_name}`} title="Edit details" className="rounded p-1 text-muted hover:bg-gray-100 hover:text-ink" onClick={() => setPerson({ id: t.id })}><Pencil className="h-3.5 w-3.5" /></button>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted">
                  {a !== null ? `${a} yrs` : <span className="text-amber-700">no date of birth</span>}
                  {exp && exp.tone !== "grey" && <Badge tone={exp.tone}>Passport: {exp.text.toLowerCase()}</Badge>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {person && (
        <PersonDialog personId={person.id} kind="traveller" defaults={{ mobile: customer.mobile }} onClose={() => setPerson(null)}
          onSaved={(p) => { if (!person.id) { setExtra((x) => [...x, p]); toggle(p.id, true); } }} />
      )}
    </Card>
  );
}
