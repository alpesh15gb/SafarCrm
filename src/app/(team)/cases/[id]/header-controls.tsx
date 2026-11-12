"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal } from "lucide-react";
import { Button, Field } from "@/components/ui";
import { Confirm, Dialog, Menu, useAction } from "@/components/client";
import { StaffSelect } from "@/components/pickers";
import { useApp } from "@/components/shell/shell";
import { deleteCase, getReadiness, setWorkState, updateCase } from "@/actions/cases";
import { istLocalToISO } from "@/lib/format";
import { CASE_STATUSES, STATUS_LABEL } from "@/lib/constants";
import type { Readiness } from "@/lib/readiness";

export function CaseHeaderControls({ kase }: { kase: {
  id: string; status: string; assigned_to: string | null; max_id: string; cancel_reason: string | null;
  work_state?: string; waiting_reason?: string | null; waiting_follow_up_at?: string | null;
} }) {
  const [waitFor, setWaitFor] = useState<string | null>(null);
  const [waitWhy, setWaitWhy] = useState("");
  const [waitUntil, setWaitUntil] = useState("");
  const { me, staff } = useApp();
  const router = useRouter();
  const { run, pending } = useAction();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [delOpen, setDelOpen] = useState(false);
  const [closing, setClosing] = useState<Readiness | null>(null);
  const blocked = !!closing && closing.blockers.length > 0 && me.role !== "boss";
  const [closeWhy, setCloseWhy] = useState("");
  // "waiting" is the only work status set by hand; everything else is worked out from the case's tasks
  const waiting = !!kase.work_state?.startsWith("waiting");

  return (
    <>
      <label className="flex items-center gap-1.5 text-xs text-muted">
        Stage
        <select
          className="field !w-auto text-ink"
          value={kase.status}
          disabled={pending}
          onChange={(e) => {
            if (e.target.value === "cancelled") { setReason(""); setCancelOpen(true); return; }
            if (e.target.value === "completed") {
              // show what is still open before closing
              getReadiness(kase.id).then((r) => {
                if (r.blockers.length || r.loose_ends.length) { setCloseWhy(""); setClosing(r); }
                else run(() => updateCase(kase.id, { status: "completed" }), { success: "Stage: Completed" });
              });
              return;
            }
            run(() => updateCase(kase.id, { status: e.target.value }), { success: `Stage: ${STATUS_LABEL[e.target.value]}` });
          }}
        >
          {CASE_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-xs text-muted">
        Owner
        <span className="block w-40 text-ink">
          <StaffSelect staff={staff} value={kase.assigned_to ?? ""} allowEmpty onChange={(v) => run(() => updateCase(kase.id, { assigned_to: v }), { success: "Owner changed. Their open tasks on this case moved too." })} />
        </span>
      </label>
      {/* less common actions live in one menu, so the header has just Stage and Owner */}
      <Menu trigger={<Button aria-label="More actions" className="!px-2"><MoreHorizontal className="h-4 w-4" /></Button>}>
        {waiting
          ? <button type="button" onClick={() => run(() => setWorkState(kase.id, "in_progress"), { success: "No longer waiting" })}>No longer waiting</button>
          : <>
              <button type="button" onClick={() => { setWaitWhy(""); setWaitUntil(""); setWaitFor("waiting_customer"); }}>Waiting on the customer…</button>
              <button type="button" onClick={() => { setWaitWhy(""); setWaitUntil(""); setWaitFor("waiting_supplier"); }}>Waiting on a supplier…</button>
            </>}
        {me.role === "boss" && <button type="button" className="text-red-600" onClick={() => setDelOpen(true)}>Delete case</button>}
      </Menu>
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
        <p className="mb-3 text-[13px] text-muted">Confirmed bookings must be cancelled first on the Bookings tab, so refunds and supplier charges are recorded. Bookings still Pending are closed at no charge, and any advance the client paid shows as a credit to refund.</p>
        <Field label="Reason" required><input className="field" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Client postponed the trip" /></Field>
      </Dialog>
      <Dialog
        open={!!closing}
        onClose={() => setClosing(null)}
        title={`Complete ${kase.max_id}?`}
        footer={
          <>
            <Button onClick={() => setClosing(null)}>Not yet</Button>
            <Button variant="primary" disabled={pending || !closeWhy.trim() || blocked}
              onClick={() => run(() => updateCase(kase.id, { status: "completed", complete_reason: closeWhy }), { then: () => setClosing(null) })}>
              Complete anyway
            </Button>
          </>
        }
      >
        {!!closing?.blockers.length && (
          <>
            <p className="mb-2 text-[13px] font-medium">Required work still open:</p>
            <ul className="mb-3 list-disc space-y-1 pl-5 text-[13px] text-red-800">{closing.blockers.map((x) => <li key={x.code}>{x.text}</li>)}</ul>
          </>
        )}
        {!!closing?.loose_ends.length && (
          <>
            <p className="mb-2 text-[13px]">Loose ends:</p>
            <ul className="mb-3 list-disc space-y-1 pl-5 text-[13px] text-amber-900">{closing.loose_ends.map((x) => <li key={x.code}>{x.text}</li>)}</ul>
          </>
        )}
        {!!closing?.optional.length && (
          <p className="mb-3 text-[13px] text-muted">Optional follow-ups still open (they don&apos;t stop completion): {closing.optional.map((x) => x.text).join("; ")}.</p>
        )}
        {blocked
          ? <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-800">Finish the required work first. Only the boss can complete a case past required work.</p>
          : <p className="mb-3 text-[13px] text-muted">Best is to finish these first. If the case really is done, give a reason. It is saved in the case notes and the activity history.</p>}
        <Field label="Reason" required><input className="field" autoFocus disabled={blocked} value={closeWhy} onChange={(e) => setCloseWhy(e.target.value)} placeholder="Supplier confirmed by email; payment settled in cash" /></Field>
      </Dialog>
      <Dialog
        open={!!waitFor}
        onClose={() => setWaitFor(null)}
        title={waitFor === "waiting_customer" ? "Waiting on the customer" : "Waiting on the supplier"}
        footer={
          <>
            <Button onClick={() => setWaitFor(null)}>Cancel</Button>
            <Button variant="primary" disabled={pending || !waitWhy.trim() || !waitUntil}
              onClick={() => run(() => setWorkState(kase.id, waitFor!, waitWhy, istLocalToISO(waitUntil)), { then: () => setWaitFor(null) })}>Save</Button>
          </>
        }
      >
        <p className="mb-3 text-[13px] text-muted">A follow-up task is created for the time you set; finishing it ends the waiting. Departure dates and cancellation deadlines keep running while you wait.</p>
        <div className="space-y-3">
          <Field label="Waiting for what?" required><input className="field" autoFocus value={waitWhy} onChange={(e) => setWaitWhy(e.target.value)} placeholder="Passport copy for the son" /></Field>
          <Field label="Follow up on (IST)" required><input className="field" type="datetime-local" value={waitUntil} onChange={(e) => setWaitUntil(e.target.value)} /></Field>
        </div>
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
