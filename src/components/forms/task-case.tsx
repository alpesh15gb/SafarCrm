"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Link2, Plus } from "lucide-react";
import { Button, Field, StatusBadge } from "@/components/ui";
import { useAction } from "@/components/client";
import { CasePicker, StaffSelect } from "@/components/pickers";
import { useApp } from "@/components/shell/shell";
import { createCaseFromTask, linkTaskToCase, suggestCases } from "@/actions/tasks";
import { familyMembers } from "@/actions/search";

type Picked = { id: string; label: string; sub?: string };
type Suggestion = Awaited<ReturnType<typeof suggestCases>>[number];
const REL: Record<string, string> = { payer: "pays", traveller: "travels", payer_and_traveller: "pays and travels" };

/** For a saved task: open its case, link it to an existing case (suggested first), create a case from it, or move it. */
export function TaskCasePanel({ taskId, taskTitle, linked, customer, onChanged }: {
  taskId: string; taskTitle: string; linked: Picked | null; customer: { id: string; full_name: string; corporate?: boolean } | null;
  onChanged: (c: Picked) => void;
}) {
  const { me, staff } = useApp();
  const { run, pending } = useAction();
  const [mode, setMode] = useState<"" | "link" | "create" | "move">("");
  const [suggest, setSuggest] = useState<Suggestion[] | null>(null);
  const [pick, setPick] = useState<Picked | null>(null);
  const [reason, setReason] = useState("");
  // create-from-task form
  const [title, setTitle] = useState(taskTitle);
  const [dest, setDest] = useState("");
  const [start, setStart] = useState("");
  const [assigned, setAssigned] = useState(me.id);
  const [people, setPeople] = useState<{ id: string; full_name: string; note?: string | null }[]>([]);
  const [trav, setTrav] = useState<string[]>([]);

  // reset when a different task, link or customer is shown (not on every keystroke in the task title)
  useEffect(() => {
    setMode(""); setPick(null); setReason(""); setSuggest(null);
    if (!linked && customer) suggestCases(customer.id).then(setSuggest);
  }, [taskId, linked?.id, customer?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode !== "create" || !customer) return;
    familyMembers(customer.id).then((f) => {
      const list = [...(f.corporate ? [] : [{ id: customer.id, full_name: customer.full_name }]),
        ...f.members.map((m) => ({ id: m.id, full_name: m.full_name, note: m.relation || m.designation }))];
      setPeople(list);
      setTrav(f.corporate ? [] : [customer.id]);  // a company pays but never travels
    });
  }, [mode, customer]);

  const link = (c: Picked, why?: string) =>
    run(() => linkTaskToCase(taskId, c.id, why), { then: (r) => { if (r.data) onChanged({ id: r.data.case_id, label: r.data.max_id }); setMode(""); } });

  if (linked) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/cases/${linked.id}`} className="inline-flex items-center gap-1 rounded-lg bg-gray-50 px-3 py-1.5 font-mono text-sm font-semibold hover:bg-gray-100">
            {linked.label}<ArrowRight className="h-3.5 w-3.5" />
          </Link>
          <span className="text-xs text-muted">Open linked case</span>
          {mode !== "move" && <button type="button" className="ml-auto text-xs link" onClick={() => setMode("move")}>Move to another case</button>}
        </div>
        {mode === "move" && (
          <div className="space-y-2 rounded-lg border border-dashed border-line p-3">
            <CasePicker value={pick} onChange={setPick} />
            <Field label="Why move it?" required><input className="field" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Linked to the wrong trip" /></Field>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" disabled={pending || !pick || !reason.trim()} onClick={() => pick && link(pick, reason)}>Move task</Button>
              <Button size="sm" onClick={() => setMode("")}>Cancel</Button>
            </div>
            <p className="text-xs text-muted">The move and your reason are recorded on both cases.</p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {suggest && suggest.length > 0 && mode !== "create" && (
        <div className="rounded-lg border border-line">
          <div className="border-b border-line px-3 py-1.5 text-xs font-medium text-muted">Existing trips for {customer?.full_name}. Link one before making a new MAX ID.</div>
          <ul className="divide-y divide-line">
            {suggest.map((s) => (
              <li key={s.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="font-mono font-semibold">{s.max_id}</span>
                <span className="min-w-0 flex-1 truncate">{s.title} <span className="text-xs text-muted">· {REL[s.relationship] ?? s.relationship}</span></span>
                <StatusBadge status={s.status} />
                <Button size="sm" disabled={pending} onClick={() => link({ id: s.id, label: s.max_id })}><Link2 className="h-3.5 w-3.5" />Link</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {mode === "" && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setMode("link")}><Link2 className="h-3.5 w-3.5" />Link to existing case</Button>
          <Button size="sm" onClick={() => { setTitle(taskTitle); setMode("create"); }} disabled={!customer} title={customer ? undefined : "Pick the customer first"}><Plus className="h-3.5 w-3.5" />Create case from task</Button>
          {!customer && <span className="self-center text-xs text-muted">To create a case, pick the customer above first.</span>}
        </div>
      )}
      {mode === "link" && (
        <div className="space-y-2 rounded-lg border border-dashed border-line p-3">
          <CasePicker value={pick} onChange={setPick} />
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={pending || !pick} onClick={() => pick && link(pick)}>Link</Button>
            <Button size="sm" onClick={() => setMode("")}>Cancel</Button>
          </div>
        </div>
      )}
      {mode === "create" && customer && (
        <div className="space-y-3 rounded-lg border border-dashed border-line p-3">
          <p className="text-xs text-muted">Pays: <b>{customer.full_name}</b>. The task keeps its owner, due time, priority, notes and comments; it is not marked done.</p>
          <Field label="Case title" required><input className="field" value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Who is travelling?" hint={people.length ? undefined : "Nobody to tick yet. You can add travellers on the case page."}>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {people.map((p) => (
                <label key={p.id} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={trav.includes(p.id)} onChange={(e) => setTrav((t) => (e.target.checked ? [...t, p.id] : t.filter((x) => x !== p.id)))} />
                  {p.full_name}{p.note && <span className="text-xs text-muted">· {p.note}</span>}
                </label>
              ))}
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Destination"><input className="field" value={dest} onChange={(e) => setDest(e.target.value)} /></Field>
            <Field label="Travel start"><input type="date" className="field" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="Assigned to"><StaffSelect staff={staff} value={assigned} onChange={setAssigned} disabled={me.role !== "boss"} /></Field>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={pending || !title.trim()}
              onClick={() => run(() => createCaseFromTask(taskId, { customer_id: customer.id, title, destination: dest, travel_start: start || null, assigned_to: assigned }, trav),
                { then: (r) => { if (r.data) onChanged({ id: r.data.id, label: r.data.max_id }); setMode(""); } })}>
              Create MAX ID and link
            </Button>
            <Button size="sm" onClick={() => setMode("")}>Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
