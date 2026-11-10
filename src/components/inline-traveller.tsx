"use client";
import { useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "./ui";
import { useAction } from "./client";
import { CustomerPicker } from "./pickers";
import { CustomerInline } from "./forms/customer-inline";
import { addCaseTraveller } from "@/actions/cases";

/** Find or create a person and add them to the case's travellers, without closing (or resetting) the form around it.
 *  Matching is always an explicit pick: nobody is merged by name or shared phone number. */
export function InlineTravellerAdd({ caseId, exclude, onAdded, label = "Add a traveller" }: {
  caseId: string; exclude: string[]; onAdded: (p: { id: string; full_name: string }) => void; label?: string;
}) {
  const { run, pending } = useAction();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);

  const add = (id: string) =>
    run(() => addCaseTraveller(caseId, id), {
      refresh: false,   // the page refreshes later; refreshing now would re-render the dialog's parent mid-edit
      then: (r) => { if (r.data) onAdded(r.data); setOpen(false); setCreating(null); },
    });

  if (!open) {
    return (
      <button type="button" className="mt-2 inline-flex items-center gap-1 text-xs link" onClick={() => setOpen(true)}>
        <UserPlus className="h-3.5 w-3.5" />{label}
      </button>
    );
  }
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-dashed border-line p-2.5">
      {creating !== null ? (
        <CustomerInline initialName={creating} onCancel={() => setCreating(null)} onCreated={(c) => add(c.id)} />
      ) : (
        <CustomerPicker
          value={null}
          disabled={pending}
          onChange={(o) => { if (o && !exclude.includes(o.id)) add(o.id); }}
          footer={(q, close) => (
            <button type="button" className="w-full rounded px-2 py-1.5 text-left text-sm link" onClick={() => { setCreating(q); close(); }}>
              + New person{q ? ` “${q}”` : ""}
            </button>
          )}
        />
      )}
      <Button size="sm" onClick={() => { setOpen(false); setCreating(null); }}>Done</Button>
    </div>
  );
}
