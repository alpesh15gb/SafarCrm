"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, UserPlus } from "lucide-react";
import { Badge, Button, Field } from "@/components/ui";
import { Dialog, More, useAction, useToast } from "@/components/client";
import { DropZone } from "@/components/files";
import { checkDuplicates, personForm, saveCustomer, type PersonData } from "@/actions/customers";
import { RELATIONS, RELATION_GENDER } from "@/lib/constants";
import { age, phoneError } from "@/lib/format";

export type PersonKind = "family" | "employee" | "traveller";
type V = {
  relation: string; designation: string; employee_id: string; title: string; first_name: string; last_name: string; gender: string; dob: string; mobile: string;
  passport_number: string; passport_expiry: string; passport_surname: string; passport_given_name: string; aadhaar: string; meal_pref: string; seat_pref: string;
};

/** Mstr / Miss under 12, else Mr / Mrs / Ms from gender (and relation for married women). */
export function autoTitle(v: { gender: string; dob: string; relation: string }) {
  const kid = !!v.dob && (age(v.dob) ?? 99) < 12;
  if (v.gender === "Male") return kid ? "Mstr" : "Mr";
  if (v.gender === "Female") return kid ? "Miss" : ["Wife", "Mother", "Grandmother", "Daughter-in-law"].includes(v.relation) ? "Mrs" : "Ms";
  return "";
}

const blank = (d?: { last_name?: string | null; mobile?: string }): V => ({
  relation: "", designation: "", employee_id: "", title: "", first_name: "", last_name: d?.last_name ?? "", gender: "", dob: "", mobile: d?.mobile ?? "",
  passport_number: "", passport_expiry: "", passport_surname: "", passport_given_name: "", aadhaar: "", meal_pref: "", seat_pref: "",
});

/**
 * Add or edit one person (family member, employee or traveller) and upload their documents, without leaving the page.
 * New people: pass `link` (family_id / company_id) and `defaults`. Existing: pass `personId`.
 */
export function PersonDialog({ personId, kind = "traveller", link, defaults, startOn = "details", onSaved, onClose, onAddAnother, focus }: {
  personId?: string; kind?: PersonKind; link?: { family_id?: string; company_id?: string }; defaults?: { last_name?: string | null; mobile?: string };
  startOn?: "details" | "docs"; onSaved?: (p: { id: string; full_name: string }) => void; onClose: () => void; onAddAnother?: () => void;
  /** say why the form was opened, e.g. "Add passport name and gender for the airline" */
  focus?: string;
}) {
  const toast = useToast();
  const { run, pending } = useAction();
  const [loaded, setLoaded] = useState(false);
  const [p, setP] = useState<PersonData | null>(null);
  const [ids, setIds] = useState<{ aadhaar_masked: string | null; passport: string | null }>({ aadhaar_masked: null, passport: null });
  const [docTypes, setDocTypes] = useState<string[]>([]);
  const [onFile, setOnFile] = useState<string[]>([]);
  const [step, setStep] = useState<"details" | "docs">(startOn);
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const [v, setV] = useState<V>(blank(defaults));
  const [dups, setDups] = useState<{ id: string; full_name: string; code: string; matched: string }[]>([]);
  const [docType, setDocType] = useState("");
  const [docNo, setDocNo] = useState("");
  const [docExp, setDocExp] = useState("");
  const set = (k: keyof V, val: string) => setV((x) => ({ ...x, [k]: val }));

  useEffect(() => {
    personForm(personId).then((r) => {
      setDocTypes(r.docTypes);
      setDocType(r.docTypes.find((t) => t.startsWith("Passport")) ?? r.docTypes[0] ?? "Other");
      setOnFile(r.docs);
      if (r.person) {
        const x = r.person;
        setP(x); setIds(r.ids); setSaved({ id: x.id, name: x.full_name });
        setV({
          relation: x.relation ?? "", designation: x.designation ?? "", employee_id: x.employee_id ?? "", title: x.title ?? "", first_name: x.first_name, last_name: x.last_name ?? "",
          gender: x.gender ?? "", dob: x.dob ?? "", mobile: x.mobile, passport_number: r.ids.passport ?? "", passport_expiry: x.passport_expiry ?? "",
          passport_surname: x.passport_surname ?? "", passport_given_name: x.passport_given_name ?? "", aadhaar: "", meal_pref: x.meal_pref ?? "", seat_pref: x.seat_pref ?? "",
        });
      }
      setLoaded(true);
    });
  }, [personId]);

  async function save(force = false) {
    if (!v.first_name.trim()) return toast("First name is required.", "error");
    if (!v.mobile.trim()) return toast("Mobile is required. Use the family's or office's number if they don't have one.", "error");
    const pe = phoneError(v.mobile);
    if (pe) return toast(`Mobile: ${pe}`, "error");
    const passportChanged = v.passport_number.trim() !== (ids.passport ?? "");
    if (!force) {
      // families and colleagues share mobiles: a shared mobile is only a duplicate when the name is the same too
      const name = `${v.first_name} ${v.last_name}`.trim().replace(/\s+/g, " ").toLowerCase();
      const d = (await checkDuplicates(v.mobile, v.aadhaar, passportChanged ? v.passport_number : "", p?.id))
        .filter((x) => x.matched !== "mobile" || x.full_name.trim().toLowerCase() === name)
        .map((x) => (x.matched === "mobile" ? { ...x, matched: "name and mobile" } : x));
      if (d.length) { setDups(d); return; }
    }
    const payload: Record<string, unknown> = {
      id: p?.id, title: v.title || autoTitle(v), first_name: v.first_name, last_name: v.last_name, gender: v.gender, dob: v.dob, mobile: v.mobile,
      passport_expiry: v.passport_expiry, passport_surname: v.passport_surname, passport_given_name: v.passport_given_name, meal_pref: v.meal_pref, seat_pref: v.seat_pref,
    };
    if (kind === "family") payload.relation = v.relation;
    if (kind === "employee") { payload.designation = v.designation; payload.employee_id = v.employee_id; }
    if (!p) { payload.whatsapp = v.mobile; if (link?.family_id) payload.family_id = link.family_id; if (link?.company_id) payload.company_id = link.company_id; }
    if (v.aadhaar.trim()) payload.aadhaar = v.aadhaar;
    if (passportChanged) payload.passport_number = v.passport_number.trim().toUpperCase();
    const name = `${v.first_name} ${v.last_name}`.trim();
    run(() => saveCustomer(payload as never), {
      success: p ? "Details saved" : `${v.first_name} added`,
      then: (r) => {
        setDups([]);
        onSaved?.({ id: r.data!.id, full_name: name });
        if (p) return onClose();
        setSaved({ id: r.data!.id, name });
        setStep("docs");
      },
    });
  }

  const who = kind === "family" ? "family member" : kind === "employee" ? "employee" : "traveller";
  const title = step === "docs" ? `Documents for ${saved?.name ?? ""}` : p ? `Edit ${p.full_name}` : `Add a ${who}`;
  const footer = step === "docs" ? (
    <>
      {onAddAnother && startOn !== "docs" && !p && <Button onClick={onAddAnother}><UserPlus className="h-4 w-4" />Add another {who}</Button>}
      {saved && <Link className="inline-flex h-9 items-center rounded-lg px-3 text-sm text-muted hover:text-ink" href={`/customers/${saved.id}?tab=documents`}>Open full documents page</Link>}
      <Button variant="primary" onClick={onClose}>Done</Button>
    </>
  ) : (
    <>
      <Button onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={pending || !loaded} onClick={() => save()}>{p ? "Save details" : "Save and add documents"}</Button>
    </>
  );

  return (
    <Dialog open onClose={onClose} title={title} footer={footer} wide>
      {!loaded ? <p className="text-sm text-muted">Loading…</p> : step === "details" ? (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!pending) save(); }}>
          {focus && <p className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">{focus}</p>}
          {dups.length > 0 && (
            <div className="rounded-lg bg-amber-50 p-2.5 text-sm text-amber-900">
              Same {dups[0].matched} is already on file for:{" "}
              {dups.map((d) => <Link key={d.id} className="underline" href={`/customers/${d.id}`}>{d.full_name} ({d.code})</Link>)}.
              <button type="button" className="ml-2 text-xs underline" onClick={() => save(true)}>Save anyway</button>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            {kind === "family" && (
              <Field label="Relation">
                <select className="field" value={v.relation} onChange={(e) => setV((x) => ({ ...x, relation: e.target.value, gender: RELATION_GENDER[e.target.value] ?? x.gender }))}>
                  <option value="">—</option>{RELATIONS.map((r) => <option key={r}>{r}</option>)}
                </select>
              </Field>
            )}
            {kind === "employee" && (
              <>
                <Field label="Designation"><input className="field" value={v.designation} onChange={(e) => set("designation", e.target.value)} /></Field>
                <Field label="Employee ID"><input className="field" value={v.employee_id} onChange={(e) => set("employee_id", e.target.value)} /></Field>
              </>
            )}
            <Field label="Gender">
              <select className="field" value={v.gender} onChange={(e) => set("gender", e.target.value)}><option value="">—</option>{["Male", "Female", "Other"].map((g) => <option key={g}>{g}</option>)}</select>
            </Field>
            <Field label="First name (as on passport)" required><input className="field" value={v.first_name} onChange={(e) => set("first_name", e.target.value)} /></Field>
            <Field label="Last name"><input className="field" value={v.last_name} onChange={(e) => set("last_name", e.target.value)} /></Field>
            <Field label="Date of birth" hint={v.dob ? `${age(v.dob)} years old` : "Needed for child / infant fares"}><input type="date" className="field" value={v.dob} onChange={(e) => set("dob", e.target.value)} /></Field>
            <Field label="Title" hint="Left blank, it is filled from gender and age">
              <select className="field" value={v.title} onChange={(e) => set("title", e.target.value)}><option value="">Auto{autoTitle(v) ? ` (${autoTitle(v)})` : ""}</option>{["Mr", "Mrs", "Ms", "Mstr", "Miss", "Dr"].map((t) => <option key={t}>{t}</option>)}</select>
            </Field>
            <Field label="Mobile" required hint={!p && defaults?.mobile && v.mobile === defaults.mobile ? "Same as the main customer's number. Change it if they have their own." : undefined}>
              <input className="field" type="tel" inputMode="tel" value={v.mobile} onChange={(e) => set("mobile", e.target.value)} />
            </Field>
          </div>
          <div className="space-y-3 rounded-lg bg-gray-50 p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Passport number" hint="Stored encrypted"><input className="field font-mono uppercase" value={v.passport_number} onChange={(e) => set("passport_number", e.target.value.toUpperCase())} /></Field>
              <Field label="Passport expiry" hint="Reminder 6 months before"><input type="date" className="field" value={v.passport_expiry} onChange={(e) => set("passport_expiry", e.target.value)} /></Field>
              <Field label="Surname as printed in passport" hint="Airlines use this for international flights">
                <input className="field uppercase" placeholder={v.last_name.toUpperCase()} value={v.passport_surname} onChange={(e) => set("passport_surname", e.target.value.toUpperCase())} />
              </Field>
              <Field label="Given name as printed in passport">
                <input className="field uppercase" placeholder={v.first_name.toUpperCase()} value={v.passport_given_name} onChange={(e) => set("passport_given_name", e.target.value.toUpperCase())} />
              </Field>
              <Field label="Aadhaar number" hint={ids.aadhaar_masked ? `On file: ${ids.aadhaar_masked}. Type to replace.` : "Stored encrypted"}>
                <input className="field font-mono" inputMode="numeric" placeholder={ids.aadhaar_masked ?? "12-digit number"} value={v.aadhaar} onChange={(e) => set("aadhaar", e.target.value.replace(/[^\d ]/g, ""))} />
              </Field>
            </div>
          </div>
          <More title="Travel preferences">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Meal"><select className="field" value={v.meal_pref} onChange={(e) => set("meal_pref", e.target.value)}><option value="">—</option>{["Veg", "Non-veg", "Jain", "Vegan", "Diabetic", "Child"].map((o) => <option key={o}>{o}</option>)}</select></Field>
              <Field label="Seat"><select className="field" value={v.seat_pref} onChange={(e) => set("seat_pref", e.target.value)}><option value="">—</option>{["Window", "Aisle"].map((o) => <option key={o}>{o}</option>)}</select></Field>
            </div>
          </More>
          {p && <p className="text-xs text-muted">Address, visas, frequent flyer and PAN are on <Link className="link" href={`/customers/${p.id}`}>{p.first_name}&apos;s full profile</Link>.</p>}
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
            onDone={(n) => { if (n) setOnFile((u) => [...new Set([...u, docType])]); setDocNo(""); setDocExp(""); }} />
          {onFile.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="text-muted">On file:</span>
              {onFile.map((d) => <Badge key={d} tone="green"><Check className="h-3 w-3" />{d}</Badge>)}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
