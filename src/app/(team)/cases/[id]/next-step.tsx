"use client";
import { Check, Plus } from "lucide-react";
import { Button, StatusBadge, cx } from "@/components/ui";
import { useAction } from "@/components/client";
import { useApp } from "@/components/shell/shell";
import { setTaskStatus } from "@/actions/tasks";
import { fdatetime } from "@/lib/format";
import type { WorkSummary } from "../board";

/** The one line that says what this case needs next: the next task (finish it here), or a prompt to add one. */
export function NextStepBar({ w, kase }: { w: WorkSummary | null; kase: { id: string; max_id: string; title: string } }) {
  const { openNew, askNext } = useApp();
  const { run, pending } = useAction();
  if (!w || w.state === "closed") return null;
  const preset = { case: { id: kase.id, label: kase.max_id, sub: kase.title } };
  const next = w.next_action;
  const late = !!next?.due_at && new Date(next.due_at) < new Date();
  const none = w.state === "no_next_step";
  return (
    <div className={cx("mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-2.5 text-[13px]",
      none || late ? "border-red-200 bg-red-50" : "border-line bg-white")}>
      <StatusBadge status={w.state} />
      {none ? (
        <span className="min-w-0 flex-1 text-red-900">Nobody has a task on this case. Add the next step so it isn&apos;t forgotten.</span>
      ) : next ? (
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => next.id && openNew("task", { task_id: next.id })}>
          <span className="font-medium">Next: {next.title}</span>
          <span className={cx("text-muted", late && "font-medium !text-red-700")}>
            {next.due_at && <> · {fdatetime(next.due_at)}</>}{next.assignee && <> · {next.assignee}</>}
            {w.open_tasks > 1 && <> · {w.open_tasks - 1} more open</>}
          </span>
          {w.state.startsWith("waiting") && w.waiting_reason && <span className="block text-xs text-amber-800">Waiting: {w.waiting_reason}</span>}
        </button>
      ) : <span className="flex-1" />}
      {next?.id && (
        <Button size="sm" disabled={pending}
          onClick={() => run(() => setTaskStatus(next.id!, "done"), { then: (r) => askNext(r.data?.needs_next ?? null) })}>
          <Check className="h-3.5 w-3.5" />Done
        </Button>
      )}
      <Button size="sm" variant={none ? "primary" : "secondary"} onClick={() => openNew("task", preset)}><Plus className="h-3.5 w-3.5" />{none ? "Add next step" : "Add step"}</Button>
    </div>
  );
}
