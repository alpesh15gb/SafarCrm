import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, Chips, PageHeader, Pager, cx } from "@/components/ui";
import { NewButton, SearchBox } from "@/components/list-tools";
import { TaskList } from "@/components/task-list";
import { dueBucket, type TaskRow } from "@/lib/tasks";
import { todayIST } from "@/lib/format";

export const metadata = { title: "Tasks" };
type SP = { staff?: string; status?: string; due?: string; open?: string; q?: string; page?: string; link?: string };

const SEL = "id, title, due_at, priority, status, alert, assigned_to, case_id, blocking, assignee:profiles!tasks_assigned_to_fkey(full_name), case:cases(max_id, title), customer_id, customer:customers(full_name)";
const PER_PAGE = 50;

export default async function TasksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const me = await requireTeam();
  const sp = await searchParams;
  const sb = await createClient();
  const boss = me.role === "boss";
  const status = sp.status ?? "open";
  const page = Math.max(1, Number(sp.page) || 1);
  const now = new Date().toISOString();

  // exact count + one page at a time (no silent cap on how many tasks exist)
  let q = sb.from("tasks").select(SEL, { count: "exact" });
  if (!boss) q = q.eq("assigned_to", me.id);
  else if (sp.staff) q = q.eq("assigned_to", sp.staff);
  if (status === "open") q = q.neq("status", "done");
  else if (status !== "all") q = q.eq("status", status);
  if (sp.due === "overdue") q = q.lt("due_at", now);
  // same meaning as the dashboard: still due later today (anything already past its time is under Overdue)
  if (sp.due === "today") q = q.gte("due_at", now).lte("due_at", todayIST() + "T23:59:59+05:30");
  if (sp.due === "week") q = q.lte("due_at", todayIST(7) + "T23:59:59+05:30");
  if (sp.link === "case") q = q.not("case_id", "is", null);
  if (sp.link === "customer") q = q.is("case_id", null).not("customer_id", "is", null);
  if (sp.link === "office") q = q.is("case_id", null).is("customer_id", null);
  if (sp.q) q = q.ilike("title", `%${sp.q.replace(/[,()%]/g, "").trim()}%`);
  q = status === "done" ? q.order("completed_at", { ascending: false }) : q.order("due_at", { nullsFirst: false });
  q = q.order("id").range((page - 1) * PER_PAGE, page * PER_PAGE - 1);

  const overdueQ = sb.from("tasks").select("assigned_to").neq("status", "done").lt("due_at", now).limit(5000);
  const [{ data, count, error }, { data: staff }, { data: overdue }] = await Promise.all([
    q,
    boss ? sb.from("profiles").select("id, full_name").in("role", ["boss", "staff"]).eq("active", true).order("full_name") : Promise.resolve({ data: [] }),
    boss ? overdueQ : Promise.resolve({ data: [] }),
  ]);
  const tasks = (data ?? []) as unknown as TaskRow[];
  const total = count ?? tasks.length;
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
      <PageHeader title={boss ? "Tasks" : "My tasks"} sub={`Reminders are tasks with an alert time · ${total} found`} action={<NewButton kind="task" label="New task" />} />
      <div className="mb-3 space-y-2">
        <SearchBox placeholder="Search task titles" />
        <Chips param="status" current={status === "open" ? "" : status} base={sp} allLabel="Open" items={[{ value: "in_progress", label: "In progress" }, { value: "done", label: "Done" }, { value: "all", label: "All" }]} />
        <Chips param="due" current={sp.due} base={sp} allLabel="Any due date" items={[{ value: "overdue", label: "Overdue" }, { value: "today", label: "Due today" }, { value: "week", label: "Next 7 days" }]} />
        <Chips param="link" current={sp.link} base={sp} allLabel="Any link" items={[{ value: "case", label: "On a MAX ID" }, { value: "customer", label: "Customer, no case yet" }, { value: "office", label: "Office tasks" }]} />
        {boss && (
          <Chips param="staff" current={sp.staff} base={sp} allLabel="Everyone"
            items={(staff ?? []).map((s: { id: string; full_name: string }) => ({ value: s.id, label: `${s.full_name}${overdueBy.get(s.id) ? ` · ${overdueBy.get(s.id)} overdue` : ""}` }))} />
        )}
      </div>
      <Card pad={false}>
        {error && <p role="alert" className="p-4 text-sm text-red-700">Tasks could not be loaded. Refresh the page to try again.</p>}
        {!error && tasks.length === 0 && <TaskList tasks={[]} newPreset={{}} emptyText={sp.q ? `No tasks match “${sp.q}”.` : "No tasks here. Create one and it shows up in the right person's day."} />}
        {groups.map((g) => g.list.length > 0 && (
          <div key={g.key}>
            {g.label && <div className={cx("border-b border-line bg-gray-50 px-4 py-1.5 text-xs font-medium", g.key === "overdue" && "text-red-600")}>{g.label} ({g.list.length}{total > PER_PAGE ? " on this page" : ""})</div>}
            <TaskList tasks={g.list} showAssignee={boss} />
          </div>
        ))}
        <Pager page={page} total={total} perPage={PER_PAGE} base={sp} />
      </Card>
    </>
  );
}
