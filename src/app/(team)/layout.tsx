import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Shell } from "@/components/shell/shell";
import { todayIST } from "@/lib/format";

export default async function TeamLayout({ children }: { children: React.ReactNode }) {
  const me = await requireTeam();
  const sb = await createClient();
  const endOfToday = `${todayIST()}T23:59:59+05:30`;
  const now = new Date().toISOString();
  const openTasks = () => {
    const q = sb.from("tasks").select("id", { count: "exact", head: true }).neq("status", "done");
    return me.role === "boss" ? q : q.eq("assigned_to", me.id);
  };
  const [{ data: staff }, { data: settings }, cases, due, overdue] = await Promise.all([
    sb.from("profiles").select("id, full_name, role").in("role", ["boss", "staff"]).eq("active", true).order("role").order("full_name"),
    sb.from("settings").select("agency_name").eq("id", 1).single(),
    sb.from("cases").select("id", { count: "exact", head: true }).not("status", "in", "(completed,cancelled)"),
    openTasks().lte("due_at", endOfToday),
    openTasks().lt("due_at", now),
  ]);
  return (
    <Shell
      me={me}
      staff={staff ?? []}
      agency={settings?.agency_name ?? "Safar CRM"}
      counts={{ cases: cases.count ?? 0, tasks: due.count ?? 0, overdue: overdue.count ?? 0 }}
    >
      {children}
    </Shell>
  );
}
