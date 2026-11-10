"use client";
import { useEffect, useState } from "react";
import { Button, Field, StatusBadge } from "@/components/ui";
import { Dialog, useAction } from "@/components/client";
import { CasePicker, StaffSelect } from "@/components/pickers";
import { NewCaseForm } from "./new-case";
import { useApp } from "@/components/shell/shell";
import { addTaskComment, deleteTask, getTaskDetail, saveTask } from "@/actions/tasks";
import { ALERTS, PRIORITIES } from "@/lib/constants";
import { fdatetime, istLocalToISO, isoToISTLocal, todayIST } from "@/lib/format";

type Picked = { id: string; label: string; sub?: string };
type Comment = { id: string; body: string; created_at: string; author: { full_name: string } | null };

export function TaskDialog({ open, onClose, preset }: { open: boolean; onClose: () => void; preset?: Record<string, unknown> }) {
  const { me, staff } = useApp();
  const { run, pending } = useAction();
  const taskId = preset?.task_id as string | undefined;
  const [kase, setKase] = useState<Picked | null>(null);
  const [cust, setCust] = useState<{ id: string; full_name: string } | null>(null);
  const [newCase, setNewCase] = useState(false);
  const [title, setTitle] = useState("");
  const [assigned, setAssigned] = useState(me.id);
  const [due, setDue] = useState("");
  const [priority, setPriority] = useState("normal");
  const [alert, setAlert] = useState("due");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState("todo");
  const [meta, setMeta] = useState<{ completed?: string; created?: string }>({});
  const [comments, setComments] = useState<Comment[]>([]);
  const [comment, setComment] = useState("");

  useEffect(() => {
    if (!open) return;
    setNewCase(false); setComment("");
    if (taskId) {
      getTaskDetail(taskId).then(({ task, comments }) => {
        if (!task) return;
        const c = task.case as { id: string; max_id: string; title: string } | null;
        setKase(c ? { id: c.id, label: c.max_id, sub: c.title } : null);
        setCust(task.customer_id && !c ? { id: task.customer_id, full_name: (task.customer as { full_name: string } | null)?.full_name ?? "Customer" } : null);
        setTitle(task.title); setAssigned(task.assigned_to ?? me.id); setDue(isoToISTLocal(task.due_at));
        setPriority(task.priority); setAlert(task.alert); setNotes(task.notes ?? ""); setStatus(task.status);
        setMeta({
          completed: task.completed_at ? `Done by ${(task.completer as { full_name: string } | null)?.full_name ?? "—"} on ${fdatetime(task.completed_at)}` : undefined,
          created: `Created ${task.created_by ? "by " + ((task.creator as { full_name: string } | null)?.full_name ?? "") : "automatically"} on ${fdatetime(task.created_at)}`,
        });
        setComments(comments as unknown as Comment[]);
      });
    } else {
      setKase((preset?.case as Picked) ?? null); setCust(null); setTitle(""); setAssigned(me.id); setDue(`${todayIST()}T18:00`);
      setPriority("normal"); setAlert("due"); setNotes(""); setStatus("todo"); setMeta({}); setComments([]);
    }
  }, [open, taskId, preset, me.id]);

  const save = () =>
    run(() => saveTask({ id: taskId, case_id: kase?.id ?? "", title, assigned_to: assigned, due_at: istLocalToISO(due), priority, alert, notes, status: taskId ? status : undefined }), {
      then: () => onClose(),
    });

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
          <Button variant="primary" disabled={pending || !title.trim()} onClick={save}>{taskId ? "Save task" : "Create task"}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {cust && <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm">About <a className="link" href={`/customers/${cust.id}`}>{cust.full_name}</a></p>}
        <Field label="MAX ID" hint="Optional. Leave empty for an office task, e.g. “Pay electricity bill”.">
          {newCase ? (
            <div className="rounded-lg border border-dashed border-line p-3">
              <NewCaseForm compact onDone={(c) => { setKase({ id: c.id, label: c.max_id }); setNewCase(false); }} />
              <button type="button" className="mt-2 text-xs link" onClick={() => setNewCase(false)}>Pick an existing case instead</button>
            </div>
          ) : (
            <div className="flex gap-2">
              <div className="flex-1"><CasePicker value={kase} onChange={setKase} /></div>
              {!taskId && <Button onClick={() => setNewCase(true)}>New MAX ID</Button>}
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
