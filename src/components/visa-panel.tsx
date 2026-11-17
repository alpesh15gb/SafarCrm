"use client";

import { useState } from "react";
import { AlertTriangle, ArrowRight, Check, CircleCheckBig, RotateCcw, X } from "lucide-react";
import { Badge, Button, Field, cx } from "./ui";
import { Dialog, useAction } from "./client";
import { duplicateLine, updateVisa } from "@/actions/bookings";
import { VISA_STATUS_TONE } from "@/lib/constants";
import { fdate, todayIST } from "@/lib/format";
import { PersonDialog } from "./person-dialog";

export type CheckItem = { item: string; done: boolean };
export type VisaTraveller = { id: string; full_name: string; passport_expiry?: string | null };

/** Older visa lines stored the checklist as text; turn either shape into tick-box items. */
export function checklistOf(d: Record<string, unknown>): CheckItem[] {
  if (Array.isArray(d.checklist)) return d.checklist as CheckItem[];
  return String(d.documents ?? "").split(/\n+/).map((x) => x.replace(/^[-•*\s]+/, "").trim()).filter(Boolean).map((item) => ({ item, done: false }));
}

const addMonths = (iso: string, m: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };
const daysUntil = (iso: string) => Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(todayIST() + "T00:00:00Z")) / 86400e3);

/** Things a beginner might not know to check. Worked out from data we already have. */
export function visaWarnings(d: Record<string, unknown>, travellers: VisaTraveller[], trip: { start: string | null; end: string | null }) {
  const out: { tone: "red" | "amber"; text: string; fixId?: string }[] = [];
  const st = String(d.application_status || "Documents pending");
  const back = trip.end || trip.start;
  for (const t of travellers) {
    if (!t.passport_expiry) out.push({ tone: "amber", text: `${t.full_name}'s passport expiry date is not saved, so we can't check it.`, fixId: t.id });
    else if (back && t.passport_expiry < addMonths(back, 3)) {
      out.push({ tone: "red", text: `${t.full_name}'s passport expires on ${fdate(t.passport_expiry)}, less than 3 months after the trip. Almost every country refuses this. Renew the passport first.` });
    } else if (back && t.passport_expiry < addMonths(back, 6)) {
      out.push({ tone: "amber", text: `${t.full_name}'s passport expires on ${fdate(t.passport_expiry)}, less than 6 months after the trip. Many countries (and airlines) need 6 months; check this country's rule before applying.` });
    }
  }
  if (trip.start && !["Approved", "Passport collected", "Rejected"].includes(st)) {
    const n = daysUntil(trip.start);
    if (n >= 0 && n <= 14) out.push({ tone: n <= 5 ? "red" : "amber", text: `The trip starts in ${n} day${n === 1 ? "" : "s"} and the visa is not approved yet.` });
    const exp = String(d.expected_by || "");
    if (exp && exp > trip.start) out.push({ tone: "red", text: `The decision is expected on ${fdate(exp)}, after the trip starts on ${fdate(trip.start)}.` });
  }
  if (d.passport_with_us && trip.start && ["Approved", "Rejected"].includes(st)) {
    const n = daysUntil(trip.start);
    if (n <= 7) out.push({ tone: "red", text: `We still have the client's passport and they travel in ${n} days. Return it now.` });
  }
  return out;
}

// Simple visa flow (owner, after a client visit, 2026-11-18): attach the visa form, submit, then approved or refused.
// No application number, appointment or document checklist is asked for. Old visas keep whatever they recorded.
const STEPS = ["Form attached", "Submitted", "Decision"];
function stepOf(st: string) {
  if (["Approved", "Rejected", "Passport collected"].includes(st)) return 2;
  if (["Applied", "Appointment booked", "Biometrics done", "Under process"].includes(st)) return 1;
  return 0;
}

export function VisaPanel({ lineId, details, travellers, trip, readOnly, hasFile }: {
  lineId: string; details: Record<string, unknown>; travellers: VisaTraveller[]; trip: { start: string | null; end: string | null }; readOnly?: boolean;
  /** a file (the visa form) is attached to this booking */
  hasFile?: boolean;
}) {
  const { run, pending } = useAction();
  const d = details ?? {};
  const st = String(d.application_status || "Documents pending");
  const at = stepOf(st);
  const [dlg, setDlg] = useState<null | "approve" | "refuse">(null);
  const warnings = visaWarnings(d, travellers, trip);
  const [fix, setFix] = useState<string | null>(null);
  const upd = (patch: Record<string, unknown>, msg?: string) => run(() => updateVisa(lineId, patch, msg));

  let next: React.ReactNode = null;
  if (at === 0) {
    next = <Button variant="primary" disabled={pending} onClick={() => upd({ application_status: "Applied", applied_on: todayIST() }, "Marked as submitted")}>Submitted <ArrowRight className="h-4 w-4" /></Button>;
  } else if (at === 1) {
    next = (
      <>
        <Button variant="primary" className="!border-emerald-700 !from-emerald-500 !to-emerald-600" onClick={() => setDlg("approve")}><Check className="h-4 w-4" />Approved</Button>
        <Button onClick={() => setDlg("refuse")}><X className="h-4 w-4 text-red-500" />Refused</Button>
      </>
    );
  } else if (st === "Rejected") {
    next = <Button onClick={() => run(() => duplicateLine(lineId))}><RotateCcw className="h-4 w-4" />Apply again</Button>;
  }

  const hint =
    at === 0 ? (hasFile ? "Form attached. Press Submitted once it is sent to the embassy or VFS." : "Attach the filled visa form below, then press Submitted.")
      : at === 1 ? "Waiting for the decision. Press the result when it comes."
        : st === "Rejected" ? `Visa refused${d.refusal_reason ? `: ${d.refusal_reason}` : ""}.`
          : "Visa approved. Attach the visa copy below and send it to the client.";

  return (
    <div className="space-y-4">
      <ol className="flex items-center">
        {STEPS.map((label, i) => {
          const refused = st === "Rejected" && i === 2;
          const done = i < at || (i === 2 && at === 2 && !refused) || (i === 0 && hasFile);
          const cur = i === at && !done;
          return (
            <li key={label} className={cx("flex items-center", i < STEPS.length - 1 && "flex-1")}>
              <span className="flex items-center gap-1.5">
                <span className={cx("flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold",
                  refused ? "bg-red-500 text-white" : done ? "bg-emerald-500 text-white" : cur ? "bg-coral text-white ring-4 ring-coral/15" : "bg-gray-100 text-gray-400")}>
                  {refused ? <X className="h-3.5 w-3.5" /> : done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span className={cx("whitespace-nowrap text-[13px]", cur || refused ? "font-semibold" : done ? "font-medium" : "text-muted")}>{refused ? "Refused" : i === 2 && st !== "Rejected" && at === 2 ? "Approved" : label}</span>
              </span>
              {i < STEPS.length - 1 && <span className={cx("mx-2.5 h-0.5 min-w-4 flex-1 rounded-full", i < at ? "bg-emerald-400" : "bg-gray-200")} />}
            </li>
          );
        })}
      </ol>

      {warnings.map((w, i) => (
        <div key={i} className={cx("flex items-start gap-2 rounded-xl px-3 py-2 text-[13px] ring-1 ring-inset",
          w.tone === "red" ? "bg-red-50 text-red-800 ring-red-100" : "bg-amber-50 text-amber-900 ring-amber-100")}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{w.text}{w.fixId && <button type="button" className="ml-1.5 font-medium underline" onClick={() => setFix(w.fixId!)}>Add it now</button>}</span>
        </div>
      ))}
      {fix && <PersonDialog personId={fix} focus="Add the passport expiry date (and anything else missing) so we can check it against the trip." onClose={() => setFix(null)} />}

      <div className="rounded-xl border border-line bg-[#fafbfc] p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <Badge dot tone={VISA_STATUS_TONE[st] ?? "grey"}>{at === 0 ? "Not submitted" : at === 1 ? "Submitted" : st === "Rejected" ? "Refused" : "Approved"}</Badge>
            <p className="mt-1 text-[13px] text-muted">{hint}</p>
          </div>
          {!readOnly && <div className="flex flex-wrap gap-2">{next}</div>}
        </div>
      </div>

      {at === 2 && st !== "Rejected" && (d.valid_to || d.visa_number) ? (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-100">
          <CircleCheckBig className="h-4 w-4 text-emerald-600" />
          <span>{d.valid_to ? <>Valid until <b>{fdate(String(d.valid_to))}</b></> : null}{d.visa_number ? ` · No. ${d.visa_number}` : ""}</span>
        </div>
      ) : null}

      {!readOnly && <StepDialogs which={dlg} onClose={() => setDlg(null)} d={d} lineId={lineId} />}
    </div>
  );
}

function StepDialogs({ which, onClose, d, lineId }: { which: null | "approve" | "refuse"; onClose: () => void; d: Record<string, unknown>; lineId: string }) {
  const { run, pending } = useAction();
  const [validTo, setValidTo] = useState(String(d.valid_to ?? ""));
  const [why, setWhy] = useState("");
  const save = (patch: Record<string, unknown>, msg: string) => run(() => updateVisa(lineId, patch, msg), { then: onClose });
  if (which === "approve") {
    return (
      <Dialog open onClose={onClose} title="Visa approved"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={pending}
          onClick={() => save({ application_status: "Approved", ...(validTo ? { valid_to: validTo } : {}) }, "Visa approved")}>Save</Button></>}>
        <Field label="Valid until" hint="Optional. With it, the visa is saved on the traveller and you're reminded before it expires.">
          <input className="field" type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
        </Field>
        <p className="mt-3 text-[13px] text-muted">Then attach the visa copy on this booking and send it to the client with the WhatsApp button.</p>
      </Dialog>
    );
  }
  if (which === "refuse") {
    return (
      <Dialog open onClose={onClose} title="Visa refused"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" className="!border-red-600 !from-red-500 !to-red-600" disabled={pending}
          onClick={() => save({ application_status: "Rejected", refusal_reason: why }, "Marked as refused")}>Save</Button></>}>
        <Field label="Reason given" hint="Optional"><input className="field" autoFocus value={why} onChange={(e) => setWhy(e.target.value)} /></Field>
      </Dialog>
    );
  }
  return null;
}
