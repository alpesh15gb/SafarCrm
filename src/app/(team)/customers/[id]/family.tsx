"use client";
import { useState } from "react";
import Link from "next/link";
import { Check, FileText, Pencil, Upload, UserPlus } from "lucide-react";
import { Badge, Button, Card, Field } from "@/components/ui";
import { useAction } from "@/components/client";
import { CustomerPicker } from "@/components/pickers";
import { PersonDialog, type PersonKind } from "@/components/person-dialog";
import { linkCompany, setFamily } from "@/actions/customers";
import { age, expiryLabel, fdate, prettyPhone } from "@/lib/format";

export type FamilyMember = {
  id: string; code: string; full_name: string; relation: string | null; designation: string | null; gender: string | null; dob: string | null;
  mobile: string; passport_expiry: string | null; meal_pref: string | null; has_passport_no: boolean; has_aadhaar: boolean; docs: string[];
};
type Head = { id: string; first_name: string; last_name: string | null; mobile: string };
type Dlg = { mode: "add" | "edit" | "docs"; personId?: string; link: { family_id?: string; company_id?: string } };

export function FamilyTab({ head, family, members, employees, company, isCorporate }: {
  head: Head; family: { id: string; name: string } | null; members: FamilyMember[]; employees: FamilyMember[];
  company: { id: string; full_name: string } | null; isCorporate: boolean;
}) {
  const { run, pending } = useAction();
  const [name, setName] = useState("");
  const [dlg, setDlg] = useState<Dlg | null>(null);
  const customerId = head.id;
  const kind: PersonKind = isCorporate ? "employee" : "family";

  const dialog = dlg && (
    <PersonDialog key={`${dlg.mode}-${dlg.personId ?? "new"}`} kind={kind} personId={dlg.personId} link={dlg.link}
      defaults={{ last_name: isCorporate ? "" : head.last_name, mobile: head.mobile }} startOn={dlg.mode === "docs" ? "docs" : "details"}
      onClose={() => setDlg(null)} onAddAnother={() => setDlg({ mode: "add", link: dlg.link })} />
  );

  if (isCorporate) {
    return (
      <div className="max-w-4xl">
        <Card title={`Employees who travel · ${employees.length}`} pad={false}
          action={<Button variant="primary" size="sm" onClick={() => setDlg({ mode: "add", link: { company_id: customerId } })}><UserPlus className="h-4 w-4" />Add employee</Button>}>
          {employees.length === 0 ? (
            <p className="p-4 text-sm text-muted">No employees yet. Click <b className="text-ink">Add employee</b> for each person who travels for this company. They can then be ticked as travellers on the company&apos;s cases.</p>
          ) : (
            <ul>{employees.map((m) => <PersonRow key={m.id} m={m} isCurrent={false} pending={pending}
              onEdit={() => setDlg({ mode: "edit", personId: m.id, link: {} })} onDocs={() => setDlg({ mode: "docs", personId: m.id, link: {} })}
              onUnlink={() => run(() => linkCompany(m.id, null))} />)}</ul>
          )}
        </Card>
        {dialog}
      </div>
    );
  }

  /** Start a family for this customer if there is none yet, then open the "add member" form. */
  function addMember() {
    if (family) return setDlg({ mode: "add", link: { family_id: family.id } });
    run(() => setFamily(customerId, null, `${head.last_name || head.first_name} family`), {
      success: "Family created",
      then: (r) => r.data?.family_id && setDlg({ mode: "add", link: { family_id: r.data.family_id } }),
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
            {members.map((m) => <PersonRow key={m.id} m={m} isCurrent={m.id === customerId} pending={pending}
              onEdit={() => setDlg({ mode: "edit", personId: m.id, link: {} })}
              onDocs={() => setDlg({ mode: "docs", personId: m.id, link: {} })}
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
          {company ? <p>Employee of <Link className="link" href={`/customers/${company.id}?tab=family`}>{company.full_name}</Link></p> : <p className="text-sm text-muted">Not linked to a company.</p>}
          <div className="mt-3">
            <Field label={company ? "Change company" : "Link to a corporate customer"}>
              <CustomerPicker value={null} onChange={(o) => o && run(() => linkCompany(customerId, o.id))} />
            </Field>
            {company && <button type="button" className="mt-2 block text-xs text-muted hover:text-red-600" onClick={() => run(() => linkCompany(customerId, null))}>Remove from {company.full_name}</button>}
          </div>
        </Card>
      </div>
      {dialog}
    </div>
  );
}

function PersonRow({ m, isCurrent, pending, onEdit, onDocs, onUnlink }: { m: FamilyMember; isCurrent: boolean; pending: boolean; onEdit: () => void; onDocs: () => void; onUnlink: () => void }) {
  const exp = expiryLabel(m.passport_expiry);
  const missing = [!m.dob && "date of birth", !m.has_passport_no && "passport no.", !m.docs.length && "documents"].filter(Boolean) as string[];
  const label = m.relation ?? m.designation;
  return (
    <li className="space-y-2 border-b border-line px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            {isCurrent ? <b>{m.full_name}</b> : <Link className="link font-medium" href={`/customers/${m.id}`}>{m.full_name}</Link>}
            {label && <Badge tone="blue">{label}</Badge>}
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
        {m.has_passport_no && <Badge tone="green"><Check className="h-3 w-3" />Passport no.</Badge>}
        {exp && <Badge tone={exp.tone === "grey" ? "green" : exp.tone}>Passport {exp.text.toLowerCase()}</Badge>}
        {m.has_aadhaar && <Badge tone="green"><Check className="h-3 w-3" />Aadhaar</Badge>}
        {m.docs.map((d) => <Badge key={d}><FileText className="h-3 w-3" />{d}</Badge>)}
        {missing.length > 0 && <span className="text-xs text-amber-700">Missing: {missing.join(", ")}</span>}
        {!isCurrent && <button type="button" disabled={pending} className="ml-auto text-xs text-muted hover:text-red-600" onClick={onUnlink}>Unlink</button>}
      </div>
    </li>
  );
}
