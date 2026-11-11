"use client";
import { useState } from "react";
import { Button, Field } from "@/components/ui";
import { useToast } from "@/components/client";
import { checkDuplicates, saveCustomer } from "@/actions/customers";
import { phoneError } from "@/lib/format";

/** Minimal "name + mobile" customer creation with duplicate warning. */
export function CustomerInline({ initialName = "", onCreated, onCancel }: { initialName?: string; onCreated: (c: { id: string; full_name: string; mobile: string }) => void; onCancel?: () => void }) {
  const toast = useToast();
  // a search that was a phone number becomes the mobile, not the name
  const typedPhone = /^[+\d\s()-]{6,}$/.test(initialName.trim());
  const [name, setName] = useState(typedPhone ? "" : initialName);
  const [mobile, setMobile] = useState(typedPhone ? initialName.trim() : "");
  const [dups, setDups] = useState<{ id: string; full_name: string; code: string; matched: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [checkPhone, setCheckPhone] = useState(false);
  const mobileErr = checkPhone ? phoneError(mobile) : null;

  async function create(force = false) {
    const parts = name.trim().split(/\s+/);
    if (!parts[0] || !mobile.trim()) return toast("Name and mobile are required.", "error");
    setCheckPhone(true);
    if (phoneError(mobile)) return;
    setBusy(true);
    if (!force) {
      const d = await checkDuplicates(mobile);
      if (d.length) { setDups(d); setBusy(false); return; }
    }
    const first = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0];
    const last = parts.length > 1 ? parts[parts.length - 1] : null;
    const r = await saveCustomer({ first_name: first, last_name: last, mobile, whatsapp: mobile });
    setBusy(false);
    if (!r.ok) return toast(r.error, "error");
    toast("Customer added");
    onCreated({ id: r.data!.id, full_name: name.trim(), mobile });
  }

  return (
    <form className="space-y-3 rounded-lg border border-dashed border-line bg-gray-50 p-3" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); if (!busy) create(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" required><input className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Mobile" required>
          <input className={"field" + (mobileErr ? " !border-red-400" : "")} inputMode="tel" placeholder="98765 43210" value={mobile} aria-invalid={!!mobileErr}
            onBlur={() => mobile.trim() && setCheckPhone(true)} onChange={(e) => { setMobile(e.target.value); setDups([]); }} />
          {mobileErr && <span role="alert" className="mt-1 block text-xs font-medium text-red-600">{mobileErr}</span>}
        </Field>
      </div>
      {dups.length > 0 && (
        <div className="rounded-lg bg-amber-50 p-2.5 text-sm text-amber-900">
          Already on file with the same {dups[0].matched}:
          <ul className="mt-1 list-disc pl-5">
            {dups.map((d) => (
              <li key={d.id}>
                <button type="button" className="link" onClick={() => onCreated({ id: d.id, full_name: d.full_name, mobile })}>{d.full_name} ({d.code}) – use this one</button>
              </li>
            ))}
          </ul>
          <button type="button" className="mt-1 text-xs underline" onClick={() => create(true)}>No, create a new customer anyway</button>
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" type="submit" disabled={busy}>{busy ? "Checking…" : "Add customer"}</Button>
        {onCancel && <Button size="sm" onClick={onCancel}>Cancel</Button>}
      </div>
    </form>
  );
}
