"use client";
import { useEffect, useState } from "react";
import { Eye, Plus, X } from "lucide-react";
import { Button, Field, cx } from "@/components/ui";
import { More, useAction, useToast } from "@/components/client";
import { StaffSelect } from "@/components/pickers";
import { useApp } from "@/components/shell/shell";
import { checkDuplicates, revealAadhaar, saveCustomer } from "@/actions/customers";
import { LEAD_SOURCES, RELATIONS } from "@/lib/constants";
import { age } from "@/lib/format";

type F = { key: string; label: string; type?: "text" | "date" | "select" | "bool" | "textarea" | "tel" | "email" | "tags"; options?: string[]; half?: boolean; hint?: string; upper?: boolean };
type Rep = { key: string; label: string; cols: { key: string; label: string; type?: "date" | "select"; options?: string[] }[] };

const SECTIONS: { title: string; fields?: F[]; repeat?: Rep; open?: boolean; ids?: boolean }[] = [
  { title: "Basic", open: true, fields: [
    { key: "customer_type", label: "Customer type", type: "select", options: ["individual", "family", "corporate"], half: true },
    { key: "title", label: "Title", type: "select", options: ["Mr", "Mrs", "Ms", "Mstr", "Miss", "Dr"], half: true },
    { key: "first_name", label: "First name (as on passport)", half: true },
    { key: "middle_name", label: "Middle name", half: true },
    { key: "last_name", label: "Last name", half: true },
    { key: "gender", label: "Gender", type: "select", options: ["Male", "Female", "Other"], half: true },
    { key: "dob", label: "Date of birth", type: "date", half: true },
    { key: "nationality", label: "Nationality", half: true },
    { key: "marital_status", label: "Marital status", type: "select", options: ["Single", "Married", "Other"], half: true },
    { key: "anniversary", label: "Anniversary", type: "date", half: true },
    { key: "relation", label: "Relation in family", type: "select", options: RELATIONS, half: true, hint: "e.g. Wife, Son. Shown on the Family tab." },
  ] },
  { title: "Contact", open: true, fields: [
    { key: "mobile", label: "Mobile", type: "tel", half: true },
    { key: "whatsapp", label: "WhatsApp number", type: "tel", half: true },
    { key: "alt_mobile", label: "Alternate mobile", type: "tel", half: true },
    { key: "email", label: "Email", type: "email", half: true },
    { key: "address1", label: "Address line 1" }, { key: "address2", label: "Address line 2" },
    { key: "city", label: "City", half: true }, { key: "state", label: "State", half: true },
    { key: "pin", label: "PIN code", half: true }, { key: "country", label: "Country", half: true },
    { key: "language", label: "Preferred language", half: true },
  ] },
  { title: "Indian IDs", ids: true, fields: [
    { key: "voter_id", label: "Voter ID", half: true, upper: true },
    { key: "dl_number", label: "Driving licence no.", half: true, upper: true },
    { key: "dl_expiry", label: "Driving licence expiry", type: "date", half: true },
  ] },
  { title: "Passport", fields: [
    { key: "passport_surname", label: "Surname as printed", half: true, upper: true },
    { key: "passport_given_name", label: "Given name as printed", half: true, upper: true },
    { key: "passport_issue", label: "Issue date", type: "date", half: true },
    { key: "passport_expiry", label: "Expiry date", type: "date", half: true },
    { key: "passport_place", label: "Place of issue", half: true },
    { key: "passport_country", label: "Issuing country", half: true },
    { key: "passport_ecr", label: "ECR / ECNR", type: "select", options: ["ECNR", "ECR"], half: true },
    { key: "passport_file_no", label: "File number", half: true },
  ] },
  { title: "Visas", repeat: { key: "visas", label: "visa", cols: [
    { key: "country", label: "Country" }, { key: "type", label: "Type" }, { key: "number", label: "Number" },
    { key: "issue", label: "Issued", type: "date" }, { key: "expiry", label: "Expiry", type: "date" },
    { key: "entry", label: "Entry", type: "select", options: ["Single", "Multiple"] },
  ] } },
  { title: "Other IDs", repeat: { key: "other_ids", label: "ID", cols: [
    { key: "kind", label: "Type", type: "select", options: ["OCI card", "PR card", "Foreign national ID"] }, { key: "number", label: "Number" }, { key: "expiry", label: "Expiry", type: "date" },
  ] } },
  { title: "Frequent flyer and loyalty", repeat: { key: "loyalty", label: "programme", cols: [
    { key: "kind", label: "Kind", type: "select", options: ["Airline", "Hotel", "Other"] }, { key: "name", label: "Airline or chain" },
    { key: "programme", label: "Programme" }, { key: "number", label: "Member no." }, { key: "tier", label: "Tier" },
  ] } },
  { title: "Rail and bus", fields: [
    { key: "irctc_id", label: "IRCTC user ID", half: true },
    { key: "senior_citizen", label: "Senior citizen concession", type: "bool", half: true },
    { key: "berth_pref", label: "Preferred berth", type: "select", options: ["Lower", "Middle", "Upper", "Side lower", "Side upper"], half: true },
    { key: "bus_pref", label: "Preferred bus type", type: "select", options: ["AC sleeper", "AC seater", "Non-AC sleeper", "Non-AC seater"], half: true },
  ] },
  { title: "Travel preferences", fields: [
    { key: "seat_pref", label: "Seat", type: "select", options: ["Window", "Aisle"], half: true },
    { key: "meal_pref", label: "Meal", type: "select", options: ["Veg", "Non-veg", "Jain", "Vegan", "Diabetic", "Child"], half: true },
    { key: "special_assistance", label: "Special assistance", hint: "e.g. wheelchair", half: true },
    { key: "preferred_airlines", label: "Preferred airlines", half: true },
    { key: "hotel_star", label: "Hotel star category", type: "select", options: ["2", "3", "4", "5"], half: true },
    { key: "room_pref", label: "Room preference", half: true },
    { key: "travel_notes", label: "Notes", type: "textarea" },
  ] },
  { title: "Emergency contact", fields: [
    { key: "emergency_name", label: "Name", half: true }, { key: "emergency_relation", label: "Relation", half: true },
    { key: "emergency_mobile", label: "Mobile", type: "tel", half: true },
  ] },
  { title: "Corporate", fields: [
    { key: "company_name", label: "Company name", half: true }, { key: "gstin", label: "GSTIN", half: true, upper: true },
    { key: "designation", label: "Designation", half: true }, { key: "employee_id", label: "Employee ID", half: true },
    { key: "billing_address", label: "Billing address", type: "textarea" },
  ] },
  { title: "CRM", fields: [
    { key: "lead_source", label: "Lead source", type: "select", options: LEAD_SOURCES, half: true },
    { key: "referred_by", label: "Referred by", half: true },
    { key: "tags", label: "Tags", type: "tags", hint: "Comma separated, e.g. VIP, Corporate, Frequent", half: true },
    { key: "notes", label: "Notes", type: "textarea" },
  ] },
  { title: "Consent", fields: [
    { key: "consent_docs", label: "Consent to store documents", type: "bool", half: true },
    { key: "consent_date", label: "Consent date", type: "date", half: true },
    { key: "whatsapp_optin", label: "WhatsApp opt-in", type: "bool", half: true },
  ] },
];

type Ids = { aadhaar_masked: string | null; pan: string | null; passport: string | null };

export function CustomerForm({ customer, ids }: { customer: Record<string, unknown>; ids: Ids }) {
  const { me, staff } = useApp();
  const { run, pending } = useAction();
  const toast = useToast();
  const [f, setF] = useState<Record<string, unknown>>(customer);
  const [idv, setIdv] = useState({ aadhaar: "", pan: ids.pan ?? "", passport_number: ids.passport ?? "" });
  const [revealed, setRevealed] = useState<string | null>(null);
  const [dups, setDups] = useState<{ id: string; full_name: string; code: string; matched: string }[]>([]);
  const [sameWa, setSameWa] = useState(!customer.whatsapp || customer.whatsapp === customer.mobile);
  useEffect(() => setF(customer), [customer]);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    const d = await checkDuplicates(String(f.mobile ?? ""), idv.aadhaar, idv.passport_number !== (ids.passport ?? "") ? idv.passport_number : "", String(customer.id));
    const real = d.filter((x) => x.matched !== "mobile" || !f.family_id); // shared family mobiles are normal
    setDups(real);
    const payload: Record<string, unknown> = { ...f, id: customer.id, whatsapp: sameWa ? f.mobile : f.whatsapp };
    delete payload.family; delete payload.company;
    if (idv.aadhaar) payload.aadhaar = idv.aadhaar;
    if (idv.pan !== (ids.pan ?? "")) payload.pan = idv.pan;
    if (idv.passport_number !== (ids.passport ?? "")) payload.passport_number = idv.passport_number;
    run(() => saveCustomer(payload as never), { then: () => setIdv((x) => ({ ...x, aadhaar: "" })) });
  }

  const input = (fd: F) => {
    const v = f[fd.key];
    if (fd.type === "select")
      return (
        <select className="field" value={String(v ?? "")} onChange={(e) => set(fd.key, e.target.value)}>
          <option value="">—</option>{fd.options!.map((o) => <option key={o} value={o}>{o[0].toUpperCase() + o.slice(1)}</option>)}
        </select>
      );
    if (fd.type === "bool") return <label className="flex h-9 items-center gap-2"><input type="checkbox" checked={!!v} onChange={(e) => set(fd.key, e.target.checked)} />Yes</label>;
    if (fd.type === "textarea") return <textarea className="field min-h-16" value={String(v ?? "")} onChange={(e) => set(fd.key, e.target.value)} />;
    if (fd.type === "tags") return <input className="field" value={((v as string[]) ?? []).join(", ")} onChange={(e) => set(fd.key, e.target.value.split(",").map((t) => t.trim()).filter(Boolean))} />;
    if (fd.key === "whatsapp")
      return (
        <div className="space-y-1">
          <input className="field" type="tel" disabled={sameWa} value={String((sameWa ? f.mobile : v) ?? "")} onChange={(e) => set("whatsapp", e.target.value)} />
          <label className="flex items-center gap-1.5 text-xs text-muted"><input type="checkbox" checked={sameWa} onChange={(e) => setSameWa(e.target.checked)} />Same as mobile</label>
        </div>
      );
    return <input className={cx("field", fd.upper && "uppercase")} type={fd.type ?? "text"} value={String(v ?? "")} onChange={(e) => set(fd.key, fd.upper ? e.target.value.toUpperCase() : e.target.value)} />;
  };

  return (
    <div className="space-y-3">
      {dups.length > 0 && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Possible duplicate: {dups.map((d) => <a key={d.id} href={`/customers/${d.id}`} className="underline">{d.full_name} ({d.code}, same {d.matched})</a>).reduce((a, b) => <>{a}, {b}</>)}
        </div>
      )}
      {SECTIONS.map((s) => (
        <More key={s.title} title={s.title === "Basic" && f.dob ? `Basic · ${age(String(f.dob))} years old` : s.title} defaultOpen={s.open}>
          {s.ids && (
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <Field label="Aadhaar number" hint={ids.aadhaar_masked ? "Stored encrypted. Type a new number to replace it." : "Stored encrypted and shown masked."}>
                <div className="flex gap-2">
                  <input className="field font-mono" inputMode="numeric" placeholder={revealed ?? ids.aadhaar_masked ?? "12-digit number"} value={idv.aadhaar} onChange={(e) => setIdv({ ...idv, aadhaar: e.target.value.replace(/[^\d ]/g, "") })} />
                  {me.role === "boss" && ids.aadhaar_masked && !revealed && (
                    <Button aria-label="Reveal Aadhaar" title="Reveal (logged)" onClick={async () => { const r = await revealAadhaar(String(customer.id)); if (r.ok) setRevealed(r.data!); else toast(r.error, "error"); }}><Eye className="h-4 w-4" /></Button>
                  )}
                </div>
              </Field>
              <Field label="PAN" hint="Stored encrypted"><input className="field font-mono uppercase" value={idv.pan} onChange={(e) => setIdv({ ...idv, pan: e.target.value.toUpperCase() })} /></Field>
            </div>
          )}
          {s.title === "Passport" && (
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <Field label="Passport number" hint="Stored encrypted"><input className="field font-mono uppercase" value={idv.passport_number} onChange={(e) => setIdv({ ...idv, passport_number: e.target.value.toUpperCase() })} /></Field>
            </div>
          )}
          {s.fields && (
            <div className="grid gap-3 sm:grid-cols-2">
              {s.fields.map((fd) => <Field key={fd.key} label={fd.label} hint={fd.hint} className={fd.half ? "" : "sm:col-span-2"}>{input(fd)}</Field>)}
              {s.title === "CRM" && <Field label="Assigned staff"><StaffSelect staff={staff} allowEmpty value={String(f.assigned_to ?? "")} onChange={(v) => set("assigned_to", v)} /></Field>}
            </div>
          )}
          {s.repeat && <Repeater rep={s.repeat} rows={(f[s.repeat.key] as Record<string, string>[]) ?? []} onChange={(rows) => set(s.repeat!.key, rows)} />}
        </More>
      ))}
      <div className="sticky bottom-0 z-10 -mx-1 flex justify-end border-t border-line bg-page/95 px-1 py-3 backdrop-blur">
        <Button variant="primary" disabled={pending} onClick={save}>Save customer</Button>
      </div>
    </div>
  );
}

function Repeater({ rep, rows, onChange }: { rep: Rep; rows: Record<string, string>[]; onChange: (r: Record<string, string>[]) => void }) {
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-2 items-end gap-2 rounded-lg bg-gray-50 p-2 sm:grid-cols-[repeat(6,minmax(0,1fr))_28px]">
          {rep.cols.map((c) => (
            <Field key={c.key} label={c.label}>
              {c.type === "select" ? (
                <select className="field" value={r[c.key] ?? ""} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, [c.key]: e.target.value } : x)))}>
                  <option value="">—</option>{c.options!.map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : (
                <input className="field" type={c.type ?? "text"} value={r[c.key] ?? ""} onChange={(e) => onChange(rows.map((x, j) => (j === i ? { ...x, [c.key]: e.target.value } : x)))} />
              )}
            </Field>
          ))}
          <button type="button" aria-label="Remove" className="mb-2 text-muted hover:text-red-600" onClick={() => onChange(rows.filter((_, j) => j !== i))}><X className="h-4 w-4" /></button>
        </div>
      ))}
      <Button size="sm" onClick={() => onChange([...rows, {}])}><Plus className="h-3.5 w-3.5" />Add {rep.label}</Button>
    </div>
  );
}
