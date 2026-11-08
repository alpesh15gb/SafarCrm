"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Field } from "@/components/ui";
import { Dialog, useAction } from "@/components/client";
import { saveSupplier } from "@/actions/suppliers";
import { SUPPLIER_TYPES } from "@/lib/constants";

export function SupplierQuickForm({ initialName = "", onCreated }: { initialName?: string; onCreated: (s: { id: string; name: string }) => void }) {
  const { run, pending } = useAction();
  const [name, setName] = useState(initialName);
  const [type, setType] = useState("airline");
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Supplier name" required><input className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Type" required>
          <select className="field" value={type} onChange={(e) => setType(e.target.value)}>{SUPPLIER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select>
        </Field>
      </div>
      <Button variant="primary" size="sm" disabled={pending || !name.trim()}
        onClick={() => run(() => saveSupplier({ name, supplier_type: type, services: type === "portal" || type === "other" ? [] : [type === "airline" ? "flight" : type] }), { then: (r) => onCreated(r.data as { id: string; name: string }) })}>
        Add supplier
      </Button>
    </div>
  );
}

export function SupplierQuickDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  return (
    <Dialog open={open} onClose={onClose} title="New supplier">
      <p className="mb-3 text-[13px] text-muted">Add the name and type now; fill in bank and credit terms later.</p>
      <SupplierQuickForm onCreated={(s) => { onClose(); router.push(`/suppliers/${s.id}`); }} />
    </Dialog>
  );
}
