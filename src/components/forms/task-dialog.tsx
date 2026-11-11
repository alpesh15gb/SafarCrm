"use client";
import { useEffect, useState } from "react";
import { Button, Field, StatusBadge } from "@/components/ui";
import { Dialog, Toggle, useAction } from "@/components/client";
import { CasePicker, CustomerPicker, StaffSelect } from "@/components/pickers";
import { NewCaseForm } from "./new-case";
import { TaskCasePanel } from "./task-case";
import { useApp } from "@/components/shell/shell";
import { addTaskComment, deleteTask, getTaskDetail, saveTask, setTaskStatus, suggestCases } from "@/actions/tasks";
import { ALERTS, PRIORITIES } from "@/lib/constants";
import { fdatetime, istLocalToISO, isoToISTLocal, todayIST } from "@/lib/format";

type Picked = { id: string; label: string; sub?: string };
type Comment = { id: string; body: string; created_at: string; author: { full_name: string } | null };
type Cust = { id: string; full_name: string; corporate?: boolean };

// a new task is due at 18:00 today; late in the day that would already be overdue, so it becomes 10:00 tomorrow
function defaultDue() {
  const hour = Number(new Intl.DateTimeFormat("en-IN", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" }).format(new Date()));
  return hour >= 17 ? `${todayIST(1)}T10:00` : `${todayIST()}T18:00`;
}

export function TaskDialog({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: Record<string, unknown> }) {
  const { me, staff, askNext } = useApp();
  const { run, pending } = useAction();
  const taskId = preset?.task_id as string | undefined;
  const [kase, setKase] = useState<Picked | null>(null);
  const [cust, setCust] = useState<Cust | null>(null);
  const [newCase, setNewCase] = useState(false);
  const [title, setTitle] = useState("");
  const [assigned, setAssigned] = useState(me.id);
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState("normal");
  const [alert, setAlert] = useState("due");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("todo");
  const [blocking, setBlocking] = useState(false);
  const [meta, setMeta] = useState<{ completed?: string; created?: string }>({});
  const [comments, setComments] = useState<Comment[]>([]);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [suggest, setSuggest] = useState<Awaited<ReturnType<typeof suggestCases>>>([]);

  const load = (id: string) => {
    setLoading(true); setLoadError(false);
    getTaskDetail(id).then(({ task, comments }) => {
      setLoading(false);
      if (!task) { setLoadError(true); return; }
      const c = task.case as { id: string; max_id: string; title: string } | null;
      const cu = task.customer as { id: string; full_name: string; customer_type: string } | null;
      setKase(c ? { id: c.id, label: c.max_id, sub: c.title } : null);
      setCust(cu ? { id: cu.id, full_name: cu.full_name, corporate: cu.customer_type === "corporate" } : null);
      setTitle(task.title); setAssigned(task.assigned_to ?? me.id); setDue(isoToISTLocal(task.due_at));
      setPriority(task.priority); setAlert(task.alert); setNotes(task.notes ?? ""); setStatus(task.status); setBlocking(!!task.blocking);
      setMeta({
        completed: task.completed_at ? `Done by ${(task.completer as { full_name: string } | null)?.full_name ?? "—"} on ${fdatetime(task.completed_at)}` : undefined,
        created: `Created ${task.created_by ? "by " + ((task.creator as { full_name: string } | null)?.full_name ?? "") : "automatically"} on ${fdatetime(task.created_at)}`,
      });
      setComments(comments as unknown as Comment[]);
    }).catch(() => { setLoading(false); setLoadError(true); });
  };

  useEffect(() => {
    if (!open) return;
    setNewCase(false); setComment(""); setSuggest([]);
    if (taskId) load(taskId);
    else {
      setKase((preset?.case as Picked) ?? null);
      const pc = preset?.customer as Picked | undefined;
      setCust(pc ? { id: pc.id, full_name: pc.label } : null);
      setTitle(""); setAssigned(me.id); setDue(defaultDue());
      setPriority("normal"); setAlert("due"); setNotes(""); setStatus("todo"); setBlocking(false); setMeta({}); setComments([]);
      setLoadError(false);
    }
  }, [open, taskId, preset, me.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // new task about a customer, not yet on a case: offer their existing trips first
  useEffect(() => {
    if (!open || taskId || kase || !cust) { setSuggest([]); return; }
    suggestCases(cust.id).then(setSuggest);
  }, [open, taskId, kase, cust]);

  const save = () =>
    run(() => saveTask({
      id: taskId, case_id: kase?.id ?? null, customer_id: cust?.id ?? null, title, assigned_to: assigned, due_at: istLocalToISO(due),
      priority, alert, notes, status: taskId ? status : undefined, blocking: kase ? blocking : false,
    }), { then: () => onClose() });

  const canEditAssignee = me.role === "boss";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={taskId ? "Task" : "New task or reminder"}
      footer={
        <>
          {taskId && me.role === "boss" && (
            <Button variant="danger" className="mr-auto" disabled={pending} onClick={() => run(() => deleteTask(taskId), { then: () => onClose() })}>Delete</Button>
          )}
          <Button onClick={onClose}>Close</Button>
          {taskId && status !== "done" && !loading && !loadError && (
            <Button disabled={pending} onClick={() => run(() => setTaskStatus(taskId, "done"), { then: (r) => { askNext(r.data?.needs_next ?? null); onClose(); } })}>Mark done</Button>
          )}
          <Button variant="primary" disabled={pending || !title.trim() || loading || loadError} onClick={save}>{taskId ? "Save task" : "Create task"}</Button>
        </>
      }
    >
      {loading && <p className="mb-3 text-sm text-muted">Loading the task…</p>}
      {loadError && (
        <p role="alert" className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">
          This task could not be loaded (it may have been deleted, or it isn&apos;t yours). <button type="button" className="underline" onClick={() => taskId && load(taskId)}>Try again</button>
        </p>
      )}
      <div className="space-y-4">
        <Field label="Customer" hint="Optional. Who this is about. Office tasks leave it empty.">
          <CustomerPicker
            value={cust ? { id: cust.id, label: cust.full_name } : null}
            onChange={(o) => setCust(o ? { id: o.id, full_name: o.raw.full_name } : null)}
          />
        </Field>
        <Field label="MAX ID" hint={taskId ? undefined : "Optional. Leave empty for an office task, e.g. “Pay electricity bill”."}>
          {taskId ? (
            <TaskCasePanel taskId={taskId} taskTitle={title} linked={kase} customer={cust} onChanged={(c) => setKase(c)} />
          ) : newCase ? (
            <div className="rounded-lg border border-dashed border-line p-3">
              <NewCaseForm compact preset={cust ? { customer: { id: cust.id, label: cust.full_name } } : undefined} onDone={(c) => { setKase({ id: c.id, label: c.max_id }); setNewCase(false); }} />
              <button type="button" className="mt-2 text-xs link" onClick={() => setNewCase(false)}>Pick an existing case instead</button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="flex-1"><CasePicker value={kase} onChange={setKase} /></div>
                <Button onClick={() => setNewCase(true)}>New MAX ID</Button>
              </div>
              {suggest.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted">Existing trips for {cust?.full_name}:</span>
                  {suggest.map((s) => (
                    <button key={s.id} type="button" className="rounded-full border border-line px-2 py-0.5 hover:bg-gray-50" onClick={() => setKase({ id: s.id, label: s.max_id, sub: s.title })}>
                      <span className="font-mono font-semibold">{s.max_id}</span> {s.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </Field>
        <Field label="Title" required><input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Call client about visa documents" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Assigned to" hint={canEditAssignee ? undefined : "Staff can assign tasks to themselves only."}>
            <StaffSelect staff={staff} value={assigned} onChange={setAssigned} disabled={!canEditAssignee} />
          </Field>
          <Field label="Due (IST)"><input type="datetime-local" className="field" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
          <Field label="Priority">
            <select className="field" value={priority} onChange={(e) => setPriority(e.target.value)}>{PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
          </Field>
          <Field label="Alert">
            <select className="field" value={alert} onChange={(e) => setAlert(e.target.value)}>{ALERTS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</select>
          </Field>
          {taskId && (
            <Field label="Status">
              <select className="field" value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option>
              </select>
            </Field>
          )}
        </div>
        {kase && (
          <Toggle checked={blocking} onChange={setBlocking}
            label={<span className="text-sm">Required before the case can be completed <span className="text-xs text-muted">(otherwise an optional follow-up)</span></span>} />
        )}
        <Field label="Notes"><textarea className="field min-h-16" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {taskId && (
          <div className="space-y-3 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <StatusBadge status={status} /> {meta.created} {meta.completed && <>· {meta.completed}</>}
            </div>
            <div className="text-sm font-medium">Comments</div>
            {comments.length === 0 && <p className="text-sm text-muted">No comments yet.</p>}
            {comments.map((c) => (
              <div key={c.id} className="rounded-lg bg-gray-50 px-3 py-2 text-sm">
                <div className="text-xs text-muted">{c.author?.full_name} · {fdatetime(c.created_at)}</div>
                <div className="whitespace-pre-wrap">{c.body}</div>
              </div>
            ))}
            <div className="flex gap-2">
              <input className="field" placeholder="Write a comment" value={comment} onChange={(e) => setComment(e.target.value)} />
              <Button
                disabled={pending || !comment.trim()}
                onClick={() => run(() => addTaskComment(taskId, comment), {
                  refresh: false,
                  then: async () => { setComment(""); const d = await getTaskDetail(taskId); setComments(d.comments as unknown as Comment[]); },
                })}
              >
                Post
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
