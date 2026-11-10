import { fdate, todayIST } from "./format";

export type TaskRow = {
  id: string; title: string; due_at: string | null; priority: string; status: string; alert: string; assigned_to: string | null; case_id: string | null;
  assignee?: { full_name: string } | null; case?: { max_id: string; title: string } | null;
  customer_id?: string | null; customer?: { full_name: string } | null;
};

export function dueBucket(t: TaskRow): "overdue" | "today" | "week" | "later" {
  if (!t.due_at) return "later";
  if (new Date(t.due_at) < new Date()) return "overdue";
  const d = fdate(t.due_at).split("-").reverse().join("-");
  if (d === todayIST()) return "today";
  if (d <= todayIST(7)) return "week";
  return "later";
}

