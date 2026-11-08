"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal } from "lucide-react";
import { Button, Field } from "@/components/ui";
import { Confirm, Dialog, Menu, useAction } from "@/components/client";
import { StaffSelect } from "@/components/pickers";
import { useApp } from "@/components/shell/shell";
import { deleteCase, updateCase } from "@/actions/cases";
import { CASE_STATUSES, STATUS_LABEL } from "@/lib/constants";

export function CaseHeaderControls({ kase }: { kase: { id: string; status: string; assigned_to: string | null; max_id: string; cancel_reason: string | null } }) {
  const { me, staff } = useApp();
  const router = useRouter();
  const { run, pending } = useAction();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [delOpen, setDelOpen] = useState(false);

  return (
    <>
      <select
        aria-label="Status"
        className="field !w-auto"
        value={kase.status}
        disabled={pending}
        onChange={(e) => {
          if (e.target.value === "cancelled") { setReason(""); setCancelOpen(true); return; }
          run(() => updateCase(kase.id, { status: e.target.value }), { success: `Status: ${STATUS_LABEL[e.target.value]}` });
        }}
      >
        {CASE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </select>
      <div className="w-44">
        <StaffSelect staff={staff} value={kase.assigned_to ?? ""} allowEmpty onChange={(v) => run(() => updateCase(kase.id, { assigned_to: v }), { success: "Reassigned" })} />
      </div>
      {me.role === "boss" && (
        <Menu trigger={<Button aria-label="More actions" className="!px-2"><MoreHorizontal className="h-4 w-4" /></Button>}>
          <button type="button" className="text-red-600" onClick={() => setDelOpen(true)}>Delete case</button>
        </Menu>
      )}
      {kase.status === "cancelled" && kase.cancel_reason && <span className="w-full text-right text-xs text-red-600">Cancelled: {kase.cancel_reason}</span>}

      <Dialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={`Cancel ${kase.max_id}?`}
        footer={
          <>
            <Button onClick={() => setCancelOpen(false)}>Keep case</Button>
            <Button variant="primary" className="!border-red-600 !bg-red-600" disabled={pending || !reason.trim()}
              onClick={() => run(() => updateCase(kase.id, { status: "cancelled", cancel_reason: reason }), { success: "Case cancelled", then: () => setCancelOpen(false) })}>
              Cancel case
            </Button>
          </>
        }
      >
        <p className="mb-3 text-[13px] text-muted">To record refunds and cancellation charges, cancel each booking from the Bookings tab.</p>
        <Field label="Reason" required><input className="field" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Client postponed the trip" /></Field>
      </Dialog>
      <Confirm
        open={delOpen}
        onClose={() => setDelOpen(false)}
        title={`Delete ${kase.max_id}?`}
        text="This removes the case with its bookings, payments, files and tasks. The MAX ID will not be reused. This cannot be undone."
        confirmLabel="Delete for good"
        pending={pending}
        onConfirm={() => run(() => deleteCase(kase.id), { then: () => { setDelOpen(false); router.push("/cases"); } })}
      />
    </>
  );
}
