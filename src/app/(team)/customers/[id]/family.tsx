"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, FileText, Pencil, Upload, UserPlus } from "lucide-react";
import { Badge, Button, Card, Field } from "@/components/ui";
import { Dialog, More, useAction, useToast } from "@/components/client";
import { CustomerPicker } from "@/components/pickers";
import { DropZone } from "@/components/files";
import { checkDuplicates, getCustomerIds, linkCompany, saveCustomer, setFamily } from "@/actions/customers";
import { RELATIONS, RELATION_GENDER } from "@/lib/constants";
import { age, expiryLabel, fdate, phoneError, prettyPhone } from "@/lib/format";

export type FamilyMember = {
  id: string; code: string; title: string | null; first_name: string; last_name: string | null; full_name: string;
  relation: string | null; gender: string | null; dob: string | null; mobile: string; passport_expiry: string | null;
  meal_pref: string | null; seat_pref: string | null; has_passport_no: boolean; has_aadhaar: boolean; docs: string[];
};
type Employee = { id: string; full_name: string; mobile: string; designation?: string | null };
type Head = { id: string; first_name: string; last_name: string | null; mobile: string };

export function FamilyTab({ head, family, members, employees, company, isCorporate, docTypes }: {
  head: Head; family: { id: string; name: string } | null; members: FamilyMember[]; employees: Employee[];
  company: { id: string; full_name: string } | null; isCorporate: boolean; docTypes: string[];
}) {
  const { run, pending } = useAction();
  const [name, setName] = useState("");
  // dialog state: a new member (no member), editing one, or uploading documents for one
  const [dlg, setDlg] = useState<{ mode: "add" | "edit" | "docs"; member?: FamilyMember; familyId: string } | null>(null);
  const customerId = head.id;

  if (isCorporate) {
    return (
      <Card title="Employees (travellers)" pad={false}>
        {employees.length === 0 ? <p className="p-4 text-sm text-muted">No employees linked yet. Open an employee&apos;s profile and set their company under Family.</p> : (
          <ul>{employees.map((e) => <li key={e.id} className="flex justify-between border-b border-line px-4 py-2.5 last:border-0"><Link className="link" href={`/customers/${e.id}`}>{e.full_name}</Link><span className="text-xs text-muted">{e.designation} · {prettyPhone(e.mobile)}</span></li>)}</ul>
        )}
      </Card>
    );
  }

  /** Start a family for this customer if there is none yet, then open the "add member" form. */
  async function addMember() {
    if (family) return setDlg({ mode: "add", familyId: family.id });
    run(() => setFamily(customerId, null, `${head.last_name || head.first_name} family`), {
      success: "Family created",
      then: (r) => r.data?.family_id && setDlg({ mode: "add", familyId: r.data.family_id }),
    });
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card title={family ? `${family.name} · ${members.length} ${members.length === 1 ? "member" : "members"}` : "Family"} pad={false}
        action={<Button variant="primary" size="sm" disabled={pending} onClick={addMember}><UserPlus className="h-4 w-4" />Add family member</Button>}>
        {!family ? (
          <div className="space-y-2 p-4 text-sm text-muted">
            <p>No family yet. Click <b className="text-ink">Add family member</b> to add a wife, child or parent.</p>
            <p>Each member gets their own passport, Aadhaar and documents, and you can tick them as travellers on any case.</p>
          </div>
        ) : (
          <ul>
            {members.map((m) => <MemberRow key={m.id} m={m} isCurrent={m.id === customerId} pending={pending}
              onEdit={() => setDlg({ mode: "edit", member: m, familyId: family.id })}
              onDocs={() => setDlg({ mode: "docs", member: m, familyId: family.id })}
              onUnlink={() => run(() => setFamily(m.id, null))} />)}
          </ul>
        )}
      </Card>

      <div className="space-y-4">
        <Card title="More options">
          <div className="space-y-3">
            {family ? (
              <>
                <Field label="Link a customer who is already on file" hint="For someone already saved as a customer">
                  <CustomerPicker value={null} onChange={(o) => o && run(() => setFamily(o.id, family.id))} />
                </Field>
                <button type="button" className="block text-xs text-muted hover:text-red-600" onClick={() => run(() => setFamily(customerId, null))}>Remove {head.first_name} from this family</button>
              </>
            ) : (
              <>
                <Field label="Join an existing customer's family" hint="Pick any member of that family">
                  <CustomerPicker value={null} onChange={(o) => {
                    if (!o) return;
                    const fid = (o.raw as { family_id: string | null }).family_id;
                    if (fid) run(() => setFamily(customerId, fid));
                    else run(async () => { const r = await setFamily(o.id, null, `${(o.label.split(" ").pop() ?? o.label)} family`); return r.ok ? setFamily(customerId, r.data!.family_id) : r; });
                  }} />
                </Field>
                <Field label="Or create a family with your own name">
                  <div className="flex gap-2">
                    <input className="field" placeholder="e.g. Sharma family" value={name} onChange={(e) => setName(e.target.value)} />
                    <Button disabled={!name.trim() || pending} onClick={() => run(() => setFamily(customerId, null, name))}>Create</Button>
                  </div>
                </Field>
              </>
            )}
          </div>
        </Card>
        <Card title="Company">
          {company ? <p>Employee of <Link className="link" href={`/customers/${company.id}`}>{company.full_name}</Link></p> : <p className="text-sm text-muted">Not linked to a company.</p>}
          <div className="mt-3">
            <Field label={company ? "Change company" : "Link to a corporate customer"}>
              <CustomerPicker value={null} onChange={(o) => o && run(() => linkCompany(customerId, o.id))} />
            </Field>
          </div>
        </Card>
      </div>

      {dlg && <MemberDialog key={`${dlg.mode}-${dlg.member?.id ?? "new"}`} init={dlg} head={head} docTypes={docTypes} onClose={() => setDlg(null)}
        onAddAnother={() => setDlg({ mode: "add", familyId: dlg.familyId })} />}
    </div>
  );
}

function MemberRow({ m, isCurrent, pending, onEdit, onDocs, onUnlink }: { m: FamilyMember; isCurrent: boolean; pending: boolean; onEdit: () => void; onDocs: () => void; onUnlink: () => void }) {
  const exp = expiryLabel(m.passport_expiry);
  const missing = [!m.dob && "date of birth", !m.has_passport_no && "passport no.", !m.docs.length && "documents"].filter(Boolean) as string[];
  return (
    <li className="space-y-2 border-b border-line px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {isCurrent ? <b>{m.full_name}</b> : <Link className="link font-medium" href={`/customers/${m.id}`}>{m.full_name}</Link>}
            {m.relation && <Badge tone="blue">{m.relation}</Badge>}
            {isCurrent && <span className="text-xs text-muted">(this customer)</span>}
          </div>
          <div className="mt-0.5 text-xs text-muted">
            {[m.code, m.gender, m.dob && `${age(m.dob)} yrs · ${fdate(m.dob)}`, prettyPhone(m.mobile), m.meal_pref && `${m.meal_pref} meal`].filter(Boolean).join(" · ")}
          </div>
        </div>
        <span className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={onEdit}><Pencil className="h-3.5 w-3.5" />Edit details</Button>
          <Button size="sm" onClick={onDocs}><Upload className="h-3.5 w-3.5" />Documents</Button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {m.has_passport_no ? <Badge tone="green"><Check className="h-3 w-3" />Passport no.</Badge> : null}
        {exp && <Badge tone={exp.tone === "grey" ? "green" : exp.tone}>Passport {exp.text.toLowerCase()}</Badge>}
        {m.has_aadhaar && <Badge tone="green"><Check className="h-3 w-3" />Aadhaar</Badge>}
        {m.docs.map((d) => <Badge key={d}><FileText className="h-3 w-3" />{d}</Badge>)}
        {missing.length > 0 && <span className="text-xs text-amber-700">Missing: {missing.join(", ")}</span>}
        {!isCurrent && <button type="button" disabled={pending} className="ml-auto text-xs text-muted hover:text-red-600" onClick={onUnlink}>Unlink</button>}
      </div>
    </li>
  );
}

type V = { relation: string; title: string; first_name: string; last_name: string; gender: string; dob: string; mobile: string; passport_number: string; passport_expiry: string; aadhaar: string; meal_pref: string; seat_pref: string };

/** Child title from age and gender: Mstr / Miss under 12, else Mr / Mrs / Ms. */
function autoTitle(v: V) {
  const kid = !!v.dob && (age(v.dob) ?? 99) < 12;
  if (v.gender === "Male") return kid ? "Mstr" : "Mr";
  if (v.gender === "Female") return kid ? "Miss" : ["Wife", "Mother", "Grandmother", "Daughter-in-law"].includes(v.relation) ? "Mrs" : "Ms";
  return "";
}

function MemberDialog({ init, head, docTypes, onClose, onAddAnother }: {
  init: { mode: "add" | "edit" | "docs"; member?: FamilyMember; familyId: string }; head: Head; docTypes: string[]; onClose: () => void; onAddAnother: () => void;
}) {
  const toast = useToast();
  const { run, pending } = useAction();
  const m = init.member;
  const [step, setStep] = useState<"details" | "docs">(init.mode === "docs" ? "docs" : "details");
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(m ? { id: m.id, name: m.full_name } : null);
  const [v, setV] = useState<V>({
    relation: m?.relation ?? "", title: m?.title ?? "", first_name: m?.first_name ?? "", last_name: m ? m.last_name ?? "" : head.last_name ?? "",
    gender: m?.gender ?? "", dob: m?.dob ?? "", mobile: m?.mobile ?? head.mobile, passport_number: "", passport_expiry: m?.passport_expiry ?? "",
    aadhaar: "", meal_pref: m?.meal_pref ?? "", seat_pref: m?.seat_pref ?? "",
  });
  const [ids, setIds] = useState<{ aadhaar_masked: string | null; passport: string | null }>({ aadhaar_masked: null, passport: null });
  const [dups, setDups] = useState<{ id: string; full_name: string; code: string; matched: string }[]>([]);
  const [docType, setDocType] = useState(docTypes.find((t) => t.startsWith("Passport")) ?? docTypes[0] ?? "Other");
  const [docNo, setDocNo] = useState("");
  const [docExp, setDocExp] = useState("");
  const [uploaded, setUploaded] = useState<string[]>([]);
  const set = (k: keyof V, val: string) => setV((x) => ({ ...x, [k]: val }));

  // editing: load the stored passport number and masked Aadhaar
  useEffect(() => {
    if (!m) return;
    getCustomerIds(m.id).then((r) => { setIds(r); setV((x) => ({ ...x, passport_number: r.passport ?? "" })); });
  }, [m]);

  async function save(force = false) {
    if (!v.first_name.trim()) return toast("First name is required.", "error");
    if (!v.mobile.trim()) return toast("Mobile is required. Use the family's main number if they don't have one.", "error");
    const pe = phoneError(v.mobile);
    if (pe) return toast(`Mobile: ${pe}`, "error");
    const passportChanged = v.passport_number.trim() !== (ids.passport ?? "");
    if (!force) {
      // family members usually share a mobile: only a matching Aadhaar or passport is a real duplicate
      const d = (await checkDuplicates(v.mobile, v.aadhaar, passportChanged ? v.passport_number : "", m?.id)).filter((x) => x.matched !== "mobile");
      if (d.length) { setDups(d); return; }
    }
    const payload: Record<string, unknown> = {
      id: m?.id, family_id: init.familyId, relation: v.relation, title: v.title || autoTitle(v), first_name: v.first_name, last_name: v.last_name,
      gender: v.gender, dob: v.dob, mobile: v.mobile, passport_expiry: v.passport_expiry, meal_pref: v.meal_pref, seat_pref: v.seat_pref,
    };
    if (!m) { payload.whatsapp = v.mobile; payload.customer_type = "family"; }
    if (v.aadhaar.trim()) payload.aadhaar = v.aadhaar;
    if (passportChanged) payload.passport_number = v.passport_number.trim().toUpperCase();
    run(() => saveCustomer(payload as never), {
      success: m ? "Details saved" : `${v.first_name} added to the family`,
      then: (r) => {
        setDups([]);
        if (m) return onClose();
        setSaved({ id: r.data!.id, name: `${v.first_name} ${v.last_name}`.trim() });
        setStep("docs");
      },
    });
  }

  const title = step === "docs" ? `Documents for ${saved?.name}` : m ? `Edit ${m.full_name}` : "Add a family member";
  const footer = step === "docs" ? (
    <>
      {init.mode !== "docs" && !m && <Button onClick={onAddAnother}><UserPlus className="h-4 w-4" />Add another member</Button>}
      {saved && <Link className="inline-flex h-9 items-center rounded-lg px-3 text-sm text-muted hover:text-ink" href={`/customers/${saved.id}?tab=documents`}>Open full documents page</Link>}
      <Button variant="primary" onClick={onClose}>Done</Button>
    </>
  ) : (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={pending} onClick={() => save()}>{m ? "Save details" : "Save and add documents"}</Button>
    </>
  );

  return (
    <Dialog open onClose={onClose} title={title} footer={footer} wide>
      {step === "details" ? (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!pending) save(); }}>
          {dups.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-2.5 text-sm text-amber-900">
              Same {dups[0].matched} is already on file for:{" "}
              {dups.map((d) => <Link key={d.id} className="underline" href={`/customers/${d.id}`}>{d.full_name} ({d.code})</Link>)}.
              <button type="button" className="ml-2 text-xs underline" onClick={() => save(true)}>Save anyway</button>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Relation">
              <select className="field" value={v.relation} autoFocus onChange={(e) => setV((x) => ({ ...x, relation: e.target.value, gender: RELATION_GENDER[e.target.value] ?? x.gender }))}>
                <option value="">—</option>{RELATIONS.map((r) => <option key={r}>{r}</option>)}
              </select>
            </Field>
            <Field label="Gender">
              <select className="field" value={v.gender} onChange={(e) => set("gender", e.target.value)}><option value="">—</option>{["Male", "Female", "Other"].map((g) => <option key={g}>{g}</option>)}</select>
            </Field>
            <Field label="First name (as on passport)" required><input className="field" value={v.first_name} onChange={(e) => set("first_name", e.target.value)} /></Field>
            <Field label="Last name"><input className="field" value={v.last_name} onChange={(e) => set("last_name", e.target.value)} /></Field>
            <Field label="Date of birth" hint={v.dob ? `${age(v.dob)} years old` : "Needed for child / infant fares"}><input type="date" className="field" value={v.dob} onChange={(e) => set("dob", e.target.value)} /></Field>
            <Field label="Title" hint="Left blank, it is filled from gender and age">
              <select className="field" value={v.title} onChange={(e) => set("title", e.target.value)}><option value="">Auto{autoTitle(v) ? ` (${autoTitle(v)})` : ""}</option>{["Mr", "Mrs", "Ms", "Mstr", "Miss", "Dr"].map((t) => <option key={t}>{t}</option>)}</select>
            </Field>
            <Field label="Mobile" required hint={v.mobile === head.mobile ? "Same as the family's main number. Change it if they have their own." : undefined}>
              <input className="field" type="tel" inputMode="tel" value={v.mobile} onChange={(e) => set("mobile", e.target.value)} />
            </Field>
          </div>
          <div className="grid gap-3 rounded-lg bg-gray-50 p-3 sm:grid-cols-2">
            <Field label="Passport number" hint="Stored encrypted"><input className="field font-mono uppercase" value={v.passport_number} onChange={(e) => set("passport_number", e.target.value.toUpperCase())} /></Field>
            <Field label="Passport expiry" hint="Reminder 6 months before"><input type="date" className="field" value={v.passport_expiry} onChange={(e) => set("passport_expiry", e.target.value)} /></Field>
            <Field label="Aadhaar number" hint={ids.aadhaar_masked ? `On file: ${ids.aadhaar_masked}. Type to replace.` : "Stored encrypted"}>
              <input className="field font-mono" inputMode="numeric" placeholder={ids.aadhaar_masked ?? "12-digit number"} value={v.aadhaar} onChange={(e) => set("aadhaar", e.target.value.replace(/[^\d ]/g, ""))} />
            </Field>
          </div>
          <More title="Travel preferences">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Meal"><select className="field" value={v.meal_pref} onChange={(e) => set("meal_pref", e.target.value)}><option value="">—</option>{["Veg", "Non-veg", "Jain", "Vegan", "Diabetic", "Child"].map((o) => <option key={o}>{o}</option>)}</select></Field>
              <Field label="Seat"><select className="field" value={v.seat_pref} onChange={(e) => set("seat_pref", e.target.value)}><option value="">—</option>{["Window", "Aisle"].map((o) => <option key={o}>{o}</option>)}</select></Field>
            </div>
          </More>
          {m && <p className="text-xs text-muted">More fields (address, visas, frequent flyer, PAN) are on <Link className="link" href={`/customers/${m.id}`}>{m.first_name}&apos;s full profile</Link>.</p>}
          <button type="submit" hidden />
        </form>
      ) : saved && (
        <div className="space-y-3">
          <p className="text-sm text-muted">Upload {saved.name}&apos;s passport, Aadhaar, photo and other copies. You can upload several files one after another.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Document type"><select className="field" value={docType} onChange={(e) => setDocType(e.target.value)}>{docTypes.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Number" hint="Optional"><input className="field font-mono" value={docNo} onChange={(e) => setDocNo(e.target.value)} /></Field>
            <Field label="Expiry" hint="Optional"><input type="date" className="field" value={docExp} onChange={(e) => setDocExp(e.target.value)} /></Field>
          </div>
          <DropZone fields={{ target: "customer_doc", customer_id: saved.id, doc_type: docType, number: docNo, expiry: docExp }} label="Drop file or click (PDF, JPG, PNG · 10 MB)"
            onDone={(n) => { if (n) setUploaded((u) => [...u, docType]); setDocNo(""); setDocExp(""); }} />
          {(uploaded.length > 0 || (m?.docs.length ?? 0) > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="text-muted">On file:</span>
              {[...new Set([...(m?.docs ?? []), ...uploaded])].map((d) => <Badge key={d} tone="green"><Check className="h-3 w-3" />{d}</Badge>)}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
