"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Trash2 } from "lucide-react";
import { Button, Card, Field, cx } from "@/components/ui";
import { Confirm, Dialog, More, useAction } from "@/components/client";
import { DropZone } from "@/components/files";
import { useApp } from "@/components/shell/shell";
import { deleteSupplier, saveSupplier, saveSupplierNotes } from "@/actions/suppliers";
import { addSupplierPayment, deletePayment } from "@/actions/money";
import { amount } from "@/lib/money";
import { deleteFile } from "@/actions/files";
import { PAY_MODES, SERVICES, SERVICE_LABEL, SUPPLIER_TERMS, SUPPLIER_TYPES } from "@/lib/constants";
import { fdate, fdatetime, inr, todayIST } from "@/lib/format";

type F = { key: string; label: string; type?: "select" | "number" | "url"; options?: { value: string; label: string }[]; hint?: string; upper?: boolean; only?: string };
const SECTIONS: { title: string; open?: boolean; fields: F[] }[] = [
  { title: "Contact", open: true, fields: [{ key: "contact_person", label: "Contact person" }, { key: "mobile", label: "Mobile" }, { key: "whatsapp", label: "WhatsApp" }, { key: "email", label: "Email" }, { key: "address", label: "Address" }, { key: "city", label: "City" }] },
  { title: "Terms", open: true, fields: [
    { key: "terms", label: "Payment terms", type: "select", options: SUPPLIER_TERMS, hint: "Prepaid wallet: you top up first, and confirmed bookings draw from it on their own" },
    { key: "credit_days", label: "Credit days", type: "number", only: "credit" }, { key: "credit_limit", label: "Credit limit (₹)", type: "number", only: "credit" },
    { key: "wallet_alert_below", label: "Remind to top up below (₹)", type: "number", only: "wallet", hint: "The boss gets a reminder when the wallet drops under this. Leave empty for none." },
    { key: "default_commission", label: "Default commission %", type: "number", hint: "Pre-fills booking lines; can be changed per line" },
  ] },
  { title: "Tax and bank", fields: [
    { key: "gstin", label: "GSTIN", upper: true }, { key: "pan", label: "PAN", upper: true }, { key: "bank_account_name", label: "Account name" },
    { key: "bank_account_no", label: "Account number" }, { key: "ifsc", label: "IFSC", upper: true }, { key: "bank_name", label: "Bank" }, { key: "bank_branch", label: "Branch" }, { key: "upi", label: "UPI ID" },
  ] },
  { title: "Portal", fields: [{ key: "portal_url", label: "Portal URL", type: "url" }, { key: "portal_login", label: "Login ID", hint: "Never store passwords here" }] },
];

export function SupplierForm({ supplier }: { supplier: Record<string, unknown> }) {
  const { me } = useApp();
  const router = useRouter();
  const { run, pending } = useAction();
  const [f, setF] = useState(supplier);
  const [del, setDel] = useState(false);
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const services = (f.services as string[]) ?? [];
  return (
    <div className="space-y-3">
      <Card>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Supplier name" required><input className="field" value={String(f.name ?? "")} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Type"><select className="field" value={String(f.supplier_type)} onChange={(e) => set("supplier_type", e.target.value)}>{SUPPLIER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></Field>
          <Field label="Services offered">
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {SERVICES.map((s) => <label key={s} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={services.includes(s)} onChange={(e) => set("services", e.target.checked ? [...services, s] : services.filter((x) => x !== s))} />{SERVICE_LABEL[s]}</label>)}
            </div>
          </Field>
          <Field label="Status"><select className="field" value={String(f.status)} onChange={(e) => set("status", e.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>
        </div>
      </Card>
      {SECTIONS.map((s) => (
        <More key={s.title} title={s.title} defaultOpen={s.open}>
          <div className="grid gap-3 sm:grid-cols-2">
            {s.fields.filter((fd) => !fd.only || fd.only === f.terms).map((fd) => (
              <Field key={fd.key} label={fd.label} hint={fd.hint}>
                {fd.type === "select"
                  ? <select className="field" value={String(f[fd.key] ?? "")} onChange={(e) => set(fd.key, e.target.value)}>{fd.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                  : <input className={cx("field", fd.upper && "uppercase")} type={fd.type ?? "text"} value={String(f[fd.key] ?? "")} onChange={(e) => set(fd.key, fd.upper ? e.target.value.toUpperCase() : e.target.value)} />}
              </Field>
            ))}
          </div>
        </More>
      ))}
      <div className="flex justify-between gap-2 border-t border-line pt-3">
        {me.role === "boss" ? <Button variant="danger" onClick={() => setDel(true)}>Delete supplier</Button> : <span />}
        <Button variant="primary" disabled={pending} onClick={() => run(() => saveSupplier(f as never))}>Save supplier</Button>
      </div>
      <Confirm open={del} onClose={() => setDel(false)} title="Delete this supplier?" text="Suppliers used on bookings can't be deleted; mark them Inactive instead." confirmLabel="Delete" pending={pending}
        onConfirm={() => run(() => deleteSupplier(String(supplier.id)), { then: () => router.push("/suppliers") })} />
    </div>
  );
}

type Open = { case_id: string; max_id: string; title: string; due: number; due_date: string | null };

export function SupplierPayButton({ supplier, open, wallet = false }: { supplier: { id: string; name: string }; open: Open[]; wallet?: boolean }) {
  const { run, pending } = useAction();
  const [show, setShow] = useState(false);
  const [v, setV] = useState({ pay_date: todayIST(), mode: "bank", reference: "", notes: "" });
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [advance, setAdvance] = useState("");
  const [opening, setOpening] = useState(false);
  const total = opening ? amount(advance) : Object.values(alloc).reduce((s, a) => s + amount(a), 0) + amount(advance);
  const save = () => opening
    ? addSupplierPayment({ supplier_id: supplier.id, ...v, mode: "opening", amount: total, allocations: [] })
    : addSupplierPayment({ supplier_id: supplier.id, ...v, amount: total, allocations: Object.entries(alloc).map(([case_id, a]) => ({ case_id, amount: amount(a) })) });
  return (
    <>
      <Button variant="primary" onClick={() => { setAlloc({}); setAdvance(""); setOpening(false); setShow(true); }}>{wallet ? "Top up wallet" : "Record payment"}</Button>
      <Dialog open={show} onClose={() => setShow(false)} title={wallet ? `Top up ${supplier.name} wallet` : `Payment to ${supplier.name}`} wide
        footer={<><Button onClick={() => setShow(false)}>Cancel</Button><Button variant="primary" disabled={pending || !total || (opening && total < 0)}
          onClick={() => run(save, { then: () => setShow(false) })}>
          {opening ? `Save opening balance of ${inr(total)}` : `Save payment of ${inr(total)}`}</Button></>}>
        <div className="space-y-4">
          {wallet && (
            <label className="flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={opening} onChange={(e) => setOpening(e.target.checked)} />
              <span><span className="font-medium">Opening balance</span><span className="block text-xs text-muted">Money already in this wallet before you started using the CRM. Enter it once, dated the day you started.</span></span>
            </label>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={opening ? "Balance as on" : "Date"}><input type="date" className="field" value={v.pay_date} onChange={(e) => setV({ ...v, pay_date: e.target.value })} /></Field>
            {!opening && <Field label="Mode"><select className="field" value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })}>{PAY_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>}
            <Field label={opening ? "Note" : "Reference no."}><input className="field" value={v.reference} placeholder={opening ? "Optional" : undefined} onChange={(e) => setV({ ...v, reference: e.target.value })} /></Field>
          </div>
          {wallet && !opening && open.length > 0 && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
              The wallet is short for {open.map((o) => `${o.max_id} (${inr(o.due)})`).join(", ")}: {inr(open.reduce((s, o) => s + o.due, 0))} in all.
            </div>
          )}
          {!opening && !wallet && <>
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[13px] font-medium">
              <span>MAX IDs this payment covers</span>
              {open.length > 0 && <button type="button" className="text-xs link" onClick={() => setAlloc(Object.fromEntries(open.map((o) => [o.case_id, String(o.due)])))}>Pay all due</button>}
            </div>
            {open.length === 0 && <p className="text-sm text-muted">Nothing is due to this supplier on any MAX ID right now.</p>}
            <div className="space-y-1.5">
              {open.map((o) => (
                <div key={o.case_id} className="flex items-center gap-3 rounded-lg bg-gray-50 px-3 py-2">
                  <input type="checkbox" checked={!!alloc[o.case_id]} onChange={(e) => setAlloc((a) => { const n = { ...a }; if (e.target.checked) n[o.case_id] = String(o.due); else delete n[o.case_id]; return n; })} />
                  <span className="font-mono text-[13px] font-semibold">{o.max_id}</span>
                  <span className="min-w-0 flex-1 truncate text-sm">{o.title}<span className="text-xs text-muted"> · due {inr(o.due)}{o.due_date && ` by ${fdate(o.due_date)}`}</span></span>
                  <input className="field !w-28 tabular" inputMode="decimal" value={alloc[o.case_id] ?? ""} onChange={(e) => setAlloc((a) => ({ ...a, [o.case_id]: e.target.value }))} />
                  {amount(alloc[o.case_id]) > Number(o.due) && <span className="text-xs text-amber-700" title="More than due; the extra stays as an advance">+{inr(amount(alloc[o.case_id]) - Number(o.due))} extra</span>}
                </div>
              ))}
            </div>
          </div>
          </>}
          {wallet && <p className="rounded-lg bg-sky-50 px-3 py-2 text-[13px] text-sky-800">{opening ? "The opening balance covers any confirmed bookings already in the CRM first; the rest stays as wallet balance." : "Top-ups cover any confirmed bookings the wallet was short for first, oldest due first; the rest stays as wallet balance."}</p>}
          <Field label={opening ? "Balance in the wallet (₹)" : wallet ? "Top-up amount (₹)" : "Advance or wallet top-up (₹)"} hint={wallet ? undefined : "Money paid ahead, not for a particular MAX ID. It shows as an advance with this supplier."}>
            <input className="field !w-40 tabular" inputMode="decimal" value={advance} onChange={(e) => setAdvance(e.target.value)} />
          </Field>
        </div>
      </Dialog>
    </>
  );
}

export function SupplierFiles({ supplierId, files, notes, isBoss }: { supplierId: string; files: { id: string; file_name: string; kind: string; created_at: string }[]; notes: string | null; isBoss: boolean }) {
  const { run, pending } = useAction();
  const [kind, setKind] = useState("agreement");
  const [n, setN] = useState(notes ?? "");
  const [del, setDel] = useState<string | null>(null);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Agreements and rate sheets">
        <div className="space-y-2">
          {files.length === 0 && <p className="text-sm text-muted">No files yet.</p>}
          {files.map((f) => (
            <div key={f.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
              <FileText className="h-4 w-4 text-muted" />
              <a className="min-w-0 flex-1 truncate hover:underline" href={`/api/files/${f.id}`} target="_blank" rel="noreferrer">{f.file_name}</a>
              <span className="text-xs text-muted">{f.kind.replace("_", " ")} · {fdatetime(f.created_at)}</span>
              {isBoss && <button type="button" aria-label="Delete" className="text-muted hover:text-red-600" onClick={() => setDel(f.id)}><Trash2 className="h-4 w-4" /></button>}
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <select className="field !w-36" value={kind} onChange={(e) => setKind(e.target.value)}><option value="agreement">Agreement</option><option value="rate_sheet">Rate sheet</option><option value="other">Other</option></select>
            <div className="flex-1"><DropZone compact fields={{ target: "supplier", supplier_id: supplierId, kind }} label="Drop file or click" /></div>
          </div>
        </div>
      </Card>
      <Card title="Notes">
        <textarea className="field min-h-40" value={n} onChange={(e) => setN(e.target.value)} />
        <div className="mt-2 flex justify-end"><Button disabled={pending || n === (notes ?? "")} onClick={() => run(() => saveSupplierNotes(supplierId, n))}>Save notes</Button></div>
      </Card>
      <Confirm open={!!del} onClose={() => setDel(null)} title="Delete this file?" confirmLabel="Delete" pending={pending} onConfirm={() => del && run(() => deleteFile(del), { then: () => setDel(null) })} />
    </div>
  );
}

export function DeleteSupplierPayment({ id, text }: { id: string; text: string }) {
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" aria-label="Delete payment" className="text-muted hover:text-red-600" onClick={() => setOpen(true)}><Trash2 className="h-3.5 w-3.5" /></button>
      <Confirm open={open} onClose={() => setOpen(false)} title="Delete this supplier payment?" confirmLabel="Delete" pending={pending}
        text={`${text}. Use this to correct a wrong entry, then record it again. What we owe this supplier goes back up.`}
        onConfirm={() => run(() => deletePayment(id), { then: () => setOpen(false) })} />
    </>
  );
}
