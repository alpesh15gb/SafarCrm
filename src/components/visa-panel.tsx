"use client";

import { useRef, useState } from "react";
import { AlertTriangle, ArrowRight, ExternalLink, BookCheck, CalendarClock, Check, CircleCheckBig, Plus, RotateCcw, X } from "lucide-react";
import { Badge, Button, Field, cx } from "./ui";
import { Dialog, useAction } from "./client";
import { duplicateLine, updateVisa } from "@/actions/bookings";
import { VISA_MODES, VISA_STATUS_TONE } from "@/lib/constants";
import { fdate, todayIST } from "@/lib/format";
import { IATA_TRAVEL_CENTRE } from "@/lib/iata";

export type CheckItem = { item: string; done: boolean };
export type VisaTraveller = { id: string; full_name: string; passport_expiry?: string | null };

/** Older visa lines stored the checklist as text; turn either shape into tick-box items. */
export function checklistOf(d: Record<string, unknown>): CheckItem[] {
  if (Array.isArray(d.checklist)) return d.checklist as CheckItem[];
  return String(d.documents ?? "").split(/\n+/).map((x) => x.replace(/^[-•*\s]+/, "").trim()).filter(Boolean).map((item) => ({ item, done: false }));
}

const STEPS = ["Documents", "Applied", "Decision", "Done"];
function stepOf(st: string, passportWithUs: boolean) {
  if (st === "Passport collected" || (st === "Approved" && !passportWithUs)) return 3;
  if (["Approved", "Rejected"].includes(st)) return 2;
  if (["Applied", "Appointment booked", "Biometrics done", "Under process"].includes(st)) return 1;
  return 0;
}
const addMonths = (iso: string, m: number) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + m); return d.toISOString().slice(0, 10); };
const daysUntil = (iso: string) => Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(todayIST() + "T00:00:00Z")) / 86400e3);

/** Things a beginner might not know to check. Worked out from data we already have. */
export function visaWarnings(d: Record<string, unknown>, travellers: VisaTraveller[], trip: { start: string | null; end: string | null }) {
  const out: { tone: "red" | "amber"; text: string }[] = [];
  const st = String(d.application_status || "Documents pending");
  const back = trip.end || trip.start;
  for (const t of travellers) {
    if (!t.passport_expiry) out.push({ tone: "amber", text: `${t.full_name}'s passport expiry date is not saved. Add it on their profile so we can check it.` });
    else if (back && t.passport_expiry < addMonths(back, 6)) {
      out.push({ tone: "red", text: `${t.full_name}'s passport expires on ${fdate(t.passport_expiry)}, less than 6 months after the trip. Most countries refuse this. Renew the passport first.` });
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

export function VisaPanel({ lineId, details, travellers, trip, readOnly }: {
  lineId: string; details: Record<string, unknown>; travellers: VisaTraveller[]; trip: { start: string | null; end: string | null }; readOnly?: boolean;
}) {
  const { run, pending } = useAction();
  const d = details ?? {};
  const st = String(d.application_status || "Documents pending");
  const withUs = !!d.passport_with_us;
  // local copy so ticks show instantly and quick clicks build on each other
  const fromServer = checklistOf(d);
  const [list, setList] = useState(fromServer);
  const [seenD, setSeenD] = useState(details);
  const [inFlight, setInFlight] = useState(0);
  if (seenD !== details && inFlight === 0) { setSeenD(details); setList(fromServer); }
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const ticked = list.filter((c) => c.done).length;
  const at = stepOf(st, withUs);
  const [dlg, setDlg] = useState<null | "apply" | "approve" | "refuse">(null);
  const [newItem, setNewItem] = useState("");
  const warnings = visaWarnings(d, travellers, trip);
  // saves go one after another, so quick clicks reach the server in order
  const upd = (patch: Record<string, unknown>, msg?: string) => {
    setInFlight((n) => n + 1);
    queue.current = queue.current.then(() => run(() => updateVisa(lineId, patch, msg))).finally(() => setInFlight((n) => n - 1));
    return queue.current;
  };

  function saveList(next: CheckItem[], msg?: string) {
    setList(next);
    upd({ checklist: next }, msg);
  }
  function toggle(i: number) {
    const next = list.map((c, j) => (j === i ? { ...c, done: !c.done } : c));
    setList(next);
    const all = next.length > 0 && next.every((c) => c.done);
    // ticking the last box moves the file on by itself
    upd({ checklist: next, ...(all && st === "Documents pending" ? { application_status: "Documents received" } : {}) },
      all && st === "Documents pending" ? "All documents received" : undefined);
  }

  // the one obvious thing to do next
  let next: React.ReactNode = null;
  if (st === "Documents pending" || st === "Documents received") {
    next = (
      <Button variant="primary" onClick={() => setDlg("apply")}>
        Mark as applied <ArrowRight className="h-4 w-4" />
      </Button>
    );
  } else if (st === "Appointment booked") {
    next = <Button variant="primary" onClick={() => upd({ application_status: "Under process" }, "Appointment done. Waiting for the decision.")}>Appointment done <ArrowRight className="h-4 w-4" /></Button>;
  } else if (["Applied", "Biometrics done", "Under process"].includes(st)) {
    next = (
      <>
        <Button variant="primary" className="!border-emerald-700 !from-emerald-500 !to-emerald-600" onClick={() => setDlg("approve")}><Check className="h-4 w-4" />Visa approved</Button>
        <Button onClick={() => setDlg("refuse")}><X className="h-4 w-4 text-red-500" />Refused</Button>
      </>
    );
  } else if (st === "Approved" && withUs) {
    next = <Button variant="primary" onClick={() => upd({ passport_with_us: false, passport_returned_on: todayIST(), application_status: "Passport collected" }, "Passport returned to client")}>Passport returned to client <ArrowRight className="h-4 w-4" /></Button>;
  } else if (st === "Rejected") {
    next = <Button onClick={() => run(() => duplicateLine(lineId))}><RotateCcw className="h-4 w-4" />Apply again</Button>;
  }

  const hint =
    st === "Documents pending" ? (list.length ? `Collect the documents below and tick each one (${ticked} of ${list.length} received).` : "Collect the client's documents.")
      : st === "Documents received" ? "All documents are in. Submit the application, then press Mark as applied."
        : st === "Appointment booked" ? "After the client attends the appointment, press Appointment done."
          : ["Applied", "Biometrics done", "Under process"].includes(st) ? "Waiting for the embassy. Press the result when it comes."
            : st === "Approved" ? (withUs ? "Approved. Give the passport back to the client." : "Visa ready. Upload the visa copy below and share it with the client.")
              : st === "Rejected" ? `Visa refused${d.refusal_reason ? `: ${d.refusal_reason}` : ""}. Fees are usually not refundable.`
                : "All done. The visa is saved on the traveller's profile.";

  return (
    <div className="space-y-4">
      {/* progress */}
      <ol className="flex items-center">
        {STEPS.map((label, i) => {
          const refused = st === "Rejected" && i === 2;
          const done = i < at || (i === at && at === 3);
          const cur = i === at && !done;
          return (
            <li key={label} className={cx("flex items-center", i < STEPS.length - 1 && "flex-1")}>
              <span className="flex items-center gap-1.5">
                <span className={cx("flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold",
                  refused ? "bg-red-500 text-white" : done ? "bg-emerald-500 text-white" : cur ? "bg-coral text-white ring-4 ring-coral/15" : "bg-gray-100 text-gray-400")}>
                  {refused ? <X className="h-3.5 w-3.5" /> : done ? <Check className="h-3.5 w-3.5" /> : i + 1}
                </span>
                <span className={cx("whitespace-nowrap text-[13px]", cur || refused ? "font-semibold" : done ? "font-medium" : "text-muted")}>{refused ? "Refused" : label}</span>
              </span>
              {i < STEPS.length - 1 && <span className={cx("mx-2.5 h-0.5 min-w-4 flex-1 rounded-full", i < at ? "bg-emerald-400" : "bg-gray-200")} />}
            </li>
          );
        })}
      </ol>

      {warnings.map((w, i) => (
        <div key={i} className={cx("flex items-start gap-2 rounded-xl px-3 py-2 text-[13px] ring-1 ring-inset",
          w.tone === "red" ? "bg-red-50 text-red-800 ring-red-100" : "bg-amber-50 text-amber-900 ring-amber-100")}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{w.text}
        </div>
      ))}

      {/* what to do now */}
      <div className="rounded-xl border border-line bg-[#fafbfc] p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><Badge dot tone={VISA_STATUS_TONE[st] ?? "grey"}>{st === "Rejected" ? "Refused" : st}</Badge></div>
            <p className="mt-1 text-[13px] text-muted">{hint}</p>
            {!readOnly && st === "Documents pending" && (
              <a href={IATA_TRAVEL_CENTRE} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs link">
                Not sure what this country needs? Check the official entry rules (IATA) <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
          {!readOnly && <div className="flex flex-wrap gap-2">{next}</div>}
        </div>
        {(withUs || (!readOnly && !["Approved", "Passport collected", "Rejected"].includes(st))) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-[13px]">
            <BookCheck className="h-4 w-4 text-muted" />
            {withUs ? (
              <>
                <span className="font-medium text-amber-800">Client&apos;s passport is with us{d.passport_received_on ? ` since ${fdate(String(d.passport_received_on))}` : ""}.</span>
                {!readOnly && st !== "Approved" && <button type="button" className="link text-xs" onClick={() => upd({ passport_with_us: false, passport_returned_on: todayIST() }, "Passport returned to client")}>Returned it</button>}
              </>
            ) : (
              <>
                <span className="text-muted">Passport is with the client.</span>
                <button type="button" className="link text-xs" onClick={() => upd({ passport_with_us: true, passport_received_on: todayIST() }, "Noted: passport is with us")}>We took the passport</button>
              </>
            )}
          </div>
        )}
      </div>

      {d.appointment_date ? (
        <div className="flex items-center gap-3 rounded-xl bg-sky-50 px-3 py-2.5 text-sm text-sky-900 ring-1 ring-inset ring-sky-100">
          <CalendarClock className="h-4 w-4 shrink-0 text-sky-600" />
          <span>Appointment <b>{fdate(String(d.appointment_date))}{d.appointment_time ? ` at ${d.appointment_time}` : ""}</b>{d.appointment_center ? ` · ${d.appointment_center}` : ""}</span>
        </div>
      ) : null}

      {st === "Approved" || st === "Passport collected" ? (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2.5 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-100">
          <CircleCheckBig className="h-4 w-4 text-emerald-600" />
          <span>Valid {d.valid_from ? `${fdate(String(d.valid_from))} ` : ""}until <b>{fdate(String(d.valid_to ?? ""))}</b>{d.visa_number ? ` · No. ${d.visa_number}` : ""}{d.entry ? ` · ${d.entry} entry` : ""}{d.stay_days ? ` · stay ${d.stay_days} days` : ""}</span>
        </div>
      ) : null}

      {/* checklist */}
      {(list.length > 0 || !readOnly) && (
        <div>
          <div className="mb-2 flex items-center justify-between text-xs font-medium text-muted">
            <span>Documents {list.length > 0 && `· ${ticked} of ${list.length} received`}</span>
          </div>
          {list.length > 0 && (
            <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-gray-100">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${(ticked / list.length) * 100}%` }} />
            </div>
          )}
          <ul className="grid gap-1 sm:grid-cols-2">
            {list.map((c, i) => (
              <li key={i}>
                <label className={cx("group flex items-start gap-2 rounded-lg px-2 py-1.5 text-[13.5px]", !readOnly && "cursor-pointer hover:bg-gray-50")}>
                  <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-600" checked={c.done} disabled={readOnly} onChange={() => toggle(i)} />
                  <span className={cx(c.done && "text-muted line-through decoration-gray-300")}>{c.item}</span>
                  {!readOnly && (
                    <button type="button" aria-label={`Remove ${c.item}`} className="ml-auto hidden text-gray-400 hover:text-red-500 group-hover:block"
                      onClick={(e) => { e.preventDefault(); saveList(list.filter((_, j) => j !== i)); }}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </label>
              </li>
            ))}
          </ul>
          {!readOnly && (
            <form className="mt-1 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!newItem.trim()) return; saveList([...list, { item: newItem.trim(), done: false }]); setNewItem(""); }}>
              <input className="field !h-8 !min-h-0 !py-0 text-[13px]" placeholder="Add a document to the list" value={newItem} onChange={(e) => setNewItem(e.target.value)} />
              <Button size="sm" type="submit" disabled={!newItem.trim()}><Plus className="h-3.5 w-3.5" />Add</Button>
            </form>
          )}
        </div>
      )}

      {!readOnly && <StepDialogs which={dlg} onClose={() => setDlg(null)} d={d} lineId={lineId} />}
    </div>
  );
}

function StepDialogs({ which, onClose, d, lineId }: { which: null | "apply" | "approve" | "refuse"; onClose: () => void; d: Record<string, unknown>; lineId: string }) {
  const { run, pending } = useAction();
  const needsAppt = String(d.mode ?? "") === VISA_MODES[1];
  const [f, setF] = useState<Record<string, string>>({});
  const [seen, setSeen] = useState<typeof which>(null);
  if (which !== seen) {
    setSeen(which);
    setF({
      applied_on: String(d.applied_on || todayIST()), application_no: String(d.application_no ?? ""),
      appointment_date: String(d.appointment_date ?? ""), appointment_time: String(d.appointment_time ?? ""), appointment_center: String(d.appointment_center ?? ""),
      valid_from: String(d.valid_from ?? ""), valid_to: String(d.valid_to ?? ""), visa_number: String(d.visa_number ?? ""), refusal_reason: "",
    });
  }
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const save = (patch: Record<string, unknown>, msg: string) => run(() => updateVisa(lineId, patch, msg), { then: onClose });

  if (which === "apply") {
    return (
      <Dialog open onClose={onClose} title="Mark visa as applied"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={pending || (needsAppt && !f.appointment_date)}
          onClick={() => save({ applied_on: f.applied_on, application_no: f.application_no, appointment_date: f.appointment_date, appointment_time: f.appointment_time, appointment_center: f.appointment_center,
            application_status: f.appointment_date ? "Appointment booked" : "Applied" }, f.appointment_date ? "Applied. We'll remind you a day before the appointment." : "Marked as applied")}>Save</Button></>}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Applied on"><input className="field" type="date" value={f.applied_on} onChange={set("applied_on")} /></Field>
            <Field label="Application no." hint="Optional"><input className="field" value={f.application_no} onChange={set("application_no")} /></Field>
          </div>
          <div className={cx("rounded-xl p-3", needsAppt ? "bg-sky-50 ring-1 ring-inset ring-sky-100" : "bg-gray-50")}>
            <p className="mb-2 text-[13px] font-medium">{needsAppt ? "This visa needs an appointment (VFS, BLS or embassy)" : "Appointment (only if there is one)"}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date" required={needsAppt}><input className="field" type="date" value={f.appointment_date} onChange={set("appointment_date")} /></Field>
              <Field label="Time"><input className="field" type="time" value={f.appointment_time} onChange={set("appointment_time")} /></Field>
              <Field label="Centre" className="sm:col-span-2"><input className="field" placeholder="VFS Global, Andheri, Mumbai" value={f.appointment_center} onChange={set("appointment_center")} /></Field>
            </div>
            {needsAppt && <p className="mt-2 text-xs text-muted">Book with the exact name and date of birth printed in the passport, or the centre can turn the client away.</p>}
          </div>
        </div>
      </Dialog>
    );
  }
  if (which === "approve") {
    return (
      <Dialog open onClose={onClose} title="Visa approved 🎉"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={pending || !f.valid_to}
          onClick={() => save({ application_status: "Approved", valid_from: f.valid_from, valid_to: f.valid_to, visa_number: f.visa_number }, "Visa approved and saved on the traveller's profile")}>Save</Button></>}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Valid until" required hint="Printed on the visa"><input className="field" type="date" value={f.valid_to} onChange={set("valid_to")} /></Field>
            <Field label="Valid from"><input className="field" type="date" value={f.valid_from} onChange={set("valid_from")} /></Field>
            <Field label="Visa number" className="sm:col-span-2"><input className="field" value={f.visa_number} onChange={set("visa_number")} /></Field>
          </div>
          <p className="text-[13px] text-muted">We&apos;ll save this visa on the traveller&apos;s profile and remind you before it expires. Next, upload the visa copy on this booking so the client can download it.</p>
        </div>
      </Dialog>
    );
  }
  if (which === "refuse") {
    return (
      <Dialog open onClose={onClose} title="Visa refused"
        footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" className="!border-red-600 !from-red-500 !to-red-600" disabled={pending}
          onClick={() => save({ application_status: "Rejected", refusal_reason: f.refusal_reason }, "Marked as refused")}>Save</Button></>}>
        <div className="space-y-3">
          <Field label="Reason given" hint="Optional. Copy it from the refusal letter."><input className="field" autoFocus value={f.refusal_reason} onChange={set("refusal_reason")} /></Field>
          <p className="text-[13px] text-muted">Embassy and VFS fees are usually not refunded. Upload the refusal letter on this booking. You can use Apply again later.</p>
        </div>
      </Dialog>
    );
  }
  return null;
}
