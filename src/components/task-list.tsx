"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Check, Plus, Bell, Clock } from "lucide-react";
import { Avatar, Badge, Button, Empty, cx } from "./ui";
import { useAction } from "./client";
import { useApp } from "./shell/shell";
import { setTaskStatus, snoozeTask } from "@/actions/tasks";
import { fdatetime, ftime, fdate } from "@/lib/format";

export type { TaskRow } from "@/lib/tasks";
import type { TaskRow } from "@/lib/tasks";

const SNOOZE = [{ v: "tomorrow", l: "Tomorrow" }, { v: "three_days", l: "In 3 days" }, { v: "next_week", l: "Next week" }];

export function TaskList({ tasks, showCase = true, showAssignee = true, newPreset, emptyText = "No tasks here." }: {
  tasks: TaskRow[]; showCase?: boolean; showAssignee?: boolean; newPreset?: Record<string, unknown>; emptyText?: string;
}) {
  const { openNew, askNext } = useApp();
  const { run, pending } = useAction();
  const sp = useSearchParams();
  const open = sp.get("open");
  const [snoozing, setSnoozing] = useState<string | null>(null);
  useEffect(() => { if (open) openNew("task", { task_id: open }); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      {tasks.length === 0 && <Empty text={emptyText} action={newPreset && <Button variant="primary" onClick={() => openNew("task", newPreset)}><Plus className="h-4 w-4" />New task</Button>} />}
      <ul>
        {tasks.map((t) => {
          const done = t.status === "done";
          const overdue = !done && t.due_at && new Date(t.due_at) < new Date();
          return (
            <li key={t.id} className="border-b border-line px-4 py-3 transition-colors last:border-0 hover:bg-[#fafbfc]">
              <div className="flex items-start gap-3">
                <button
                  type="button"
                  aria-label={done ? "Mark not done" : "Mark done"}
                  disabled={pending}
                  onClick={() => run(() => setTaskStatus(t.id, done ? "todo" : "done"), { then: (r) => askNext(r.data?.needs_next ?? null) })}
                  className={cx("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-[1.5px] transition-colors", done ? "border-emerald-500 bg-emerald-500 text-white" : overdue ? "border-red-300 hover:border-emerald-500 hover:bg-emerald-50" : "border-gray-300 hover:border-emerald-500 hover:bg-emerald-50")}
                >
                  {done && <Check className="h-3.5 w-3.5" />}
                </button>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => openNew("task", { task_id: t.id })}>
                  <div className={cx("text-sm font-medium", done && "font-normal text-muted line-through")}>{t.title}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
                    {showCase && t.case && <Link href={`/cases/${t.case_id}`} onClick={(e) => e.stopPropagation()} className="font-mono font-semibold text-ink hover:underline">{t.case.max_id}</Link>}
                    {showCase && t.case?.title && <span className="max-w-[18rem] truncate">{t.case.title}</span>}
                    {showCase && !t.case && t.customer && <Link href={`/customers/${t.customer_id}`} onClick={(e) => e.stopPropagation()} className="font-semibold text-ink hover:underline">{t.customer.full_name}</Link>}
                    {t.due_at && <span className={cx(overdue && "font-medium text-red-600")}>{fdate(t.due_at) === fdate(new Date().toISOString()) ? `Today ${ftime(t.due_at)}` : fdatetime(t.due_at)}</span>}
                    {t.alert !== "none" && !done && <Bell className="h-3 w-3" />}
                  </div>
                </button>
                {t.priority === "high" && !done && <Badge dot tone="red">High</Badge>}
                {t.status === "in_progress" && <Badge dot tone="blue">In progress</Badge>}
                {!done && (
                  <button type="button" aria-label="Move to a later date" aria-expanded={snoozing === t.id} title="Move to a later date"
                    onClick={() => setSnoozing(snoozing === t.id ? null : t.id)}
                    className={cx("flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-ink", snoozing === t.id && "bg-gray-100 text-ink")}>
                    <Clock className="h-3.5 w-3.5" />
                  </button>
                )}
                {showAssignee && t.assignee && <Avatar name={t.assignee.full_name} size="sm" />}
              </div>
              {snoozing === t.id && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-8 text-xs text-muted">
                  Move to:
                  {SNOOZE.map((s) => (
                    <Button key={s.v} size="sm" disabled={pending} onClick={() => run(() => snoozeTask(t.id, s.v), { then: () => setSnoozing(null) })}>{s.l}</Button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {newPreset && tasks.length > 0 && (
        <div className="border-t border-line px-4 py-2"><Button size="sm" onClick={() => openNew("task", newPreset)}><Plus className="h-3.5 w-3.5" />New task</Button></div>
      )}
    </div>
  );
}
