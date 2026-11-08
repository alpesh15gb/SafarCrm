import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, Chips, PageHeader, cx } from "@/components/ui";
import { NewButton } from "@/components/list-tools";
import { TaskList } from "@/components/task-list";
import { dueBucket, type TaskRow } from "@/lib/tasks";
import { todayIST } from "@/lib/format";

export const metadata = { title: "Tasks" };
type SP = { staff?: string; status?: string; due?: string; open?: string };

const SEL = "id, title, due_at, priority, status, alert, assigned_to, case_id, assignee:profiles!tasks_assigned_to_fkey(full_name), case:cases(max_id, title)";

export default async function TasksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const me = await requireTeam();
  const sp = await searchParams;
  const sb = await createClient();
  const boss = me.role === "boss";
  const status = sp.status ?? "open";

  let q = sb.from("tasks").select(SEL).order("due_at", { nullsFirst: false }).limit(500);
  if (!boss) q = q.eq("assigned_to", me.id);
  else if (sp.staff) q = q.eq("assigned_to", sp.staff);
  if (status === "open") q = q.neq("status", "done");
  else if (status !== "all") q = q.eq("status", status);
  if (status === "done") q = q.order("completed_at", { ascending: false });
  const now = new Date().toISOString();
  if (sp.due === "overdue") q = q.lt("due_at", now);
  if (sp.due === "today") q = q.gte("due_at", todayIST() + "T00:00:00+05:30").lte("due_at", todayIST() + "T23:59:59+05:30");
  if (sp.due === "week") q = q.lte("due_at", todayIST(7) + "T23:59:59+05:30");

  const [{ data }, { data: staff }, { data: overdue }] = await Promise.all([
    q,
    boss ? sb.from("profiles").select("id, full_name").in("role", ["boss", "staff"]).eq("active", true).order("full_name") : Promise.resolve({ data: [] }),
    boss ? sb.from("tasks").select("assigned_to").neq("status", "done").lt("due_at", now) : Promise.resolve({ data: [] }),
  ]);
  const tasks = (data ?? []) as unknown as TaskRow[];
  const overdueBy = new Map<string, number>();
  (overdue ?? []).forEach((t: { assigned_to: string | null }) => t.assigned_to && overdueBy.set(t.assigned_to, (overdueBy.get(t.assigned_to) ?? 0) + 1));

  const groups = status === "done" || status === "all" || sp.due
    ? [{ key: "all", label: "", list: tasks }]
    : [
        { key: "overdue", label: "Overdue", list: tasks.filter((t) => dueBucket(t) === "overdue") },
        { key: "today", label: "Today", list: tasks.filter((t) => dueBucket(t) === "today") },
        { key: "week", label: "Next 7 days", list: tasks.filter((t) => dueBucket(t) === "week") },
        { key: "later", label: "Later", list: tasks.filter((t) => dueBucket(t) === "later") },
      ];

  return (
    <>
      <PageHeader title={boss ? "Tasks" : "My tasks"} sub="Reminders are tasks with an alert time." action={<NewButton kind="task" label="New task" />} />
      <div className="mb-3 space-y-2">
        <Chips param="status" current={status === "open" ? "" : status} base={sp} allLabel="Open" items={[{ value: "in_progress", label: "In progress" }, { value: "done", label: "Done" }, { value: "all", label: "All" }]} />
        <Chips param="due" current={sp.due} base={sp} allLabel="Any due date" items={[{ value: "overdue", label: "Overdue" }, { value: "today", label: "Due today" }, { value: "week", label: "Next 7 days" }]} />
        {boss && (
          <Chips param="staff" current={sp.staff} base={sp} allLabel="Everyone"
            items={(staff ?? []).map((s: { id: string; full_name: string }) => ({ value: s.id, label: `${s.full_name}${overdueBy.get(s.id) ? ` · ${overdueBy.get(s.id)} overdue` : ""}` }))} />
        )}
      </div>
      <Card pad={false}>
        {tasks.length === 0 && <TaskList tasks={[]} newPreset={{}} emptyText="No tasks here. Create one and it shows up in the right person's day." />}
        {groups.map((g) => g.list.length > 0 && (
          <div key={g.key}>
            {g.label && <div className={cx("border-b border-line bg-gray-50 px-4 py-1.5 text-xs font-medium", g.key === "overdue" && "text-red-600")}>{g.label} ({g.list.length})</div>}
            <TaskList tasks={g.list} showAssignee={boss} />
          </div>
        ))}
      </Card>
    </>
  );
}
