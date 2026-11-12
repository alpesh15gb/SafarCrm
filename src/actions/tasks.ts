"use server";
import { createClient } from "@/lib/supabase/server";
import { fail, getMe, type ActionResult } from "@/lib/auth";
import { fdate, todayIST } from "@/lib/format";

export type TaskInput = {
  id?: string;
  case_id: string | null;
  customer_id?: string | null;
  title: string;
  assigned_to: string;
  due_at: string | null;
  priority: string;
  alert: string;
  notes?: string | null;
  status?: string;
  blocking?: boolean;
};

export async function saveTask(t: TaskInput): Promise<ActionResult<{ id: string }>> {
  try {
    if (!t.title.trim()) return { ok: false, error: "Give the task a title." };
    const me = await getMe();
    if (!me) return { ok: false, error: "Please log in again." };
    if (me.role !== "boss" && t.assigned_to !== me.id) return { ok: false, error: "Staff can only assign tasks to themselves." };
    const sb = await createClient();
    const row: Record<string, unknown> = {
      title: t.title.trim(), assigned_to: t.assigned_to || me.id, due_at: t.due_at, priority: t.priority,
      alert: t.due_at ? t.alert : "none", notes: t.notes?.trim() || null, ...(t.status ? { status: t.status } : {}),
      ...(t.blocking !== undefined ? { blocking: !!t.blocking } : {}),
    };
    if ("customer_id" in t) row.customer_id = t.customer_id || null;
    if (t.id) {
      // a task's link to a case changes only through linkTaskToCase / createCaseFromTask (checked and recorded)
      const { data: cur } = await sb.from("tasks").select("case_id").eq("id", t.id).maybeSingle();
      if (!cur) return { ok: false, error: "You can't change this task." };
      if ((t.case_id || null) !== (cur.case_id ?? null)) {
        if (cur.case_id) return { ok: false, error: "Use “Move to another case” to change the case of a linked task." };
        const l = await linkTaskToCase(t.id, t.case_id as string);
        if (!l.ok) return l;
      }
      const { data, error } = await sb.from("tasks").update(row).eq("id", t.id).select("id");
      if (error) throw error;
      if (!data?.length) return { ok: false, error: "You can't change this task." };
      return { ok: true, data: { id: t.id }, message: "Task saved" };
    }
    const { data, error } = await sb.from("tasks").insert({ ...row, case_id: t.case_id || null }).select("id").single();
    if (error) throw error;
    return { ok: true, data, message: "Task created" };
  } catch (e) {
    return fail(e);
  }
}

/** A new task for a customer who has no case for it yet: the case and the task are made together, in one transaction.
 *  The task is the new case's first step. Repeating the call with the same key returns the first result. */
export async function createTaskWithCase(t: TaskInput, customerId: string, requestKey: string): Promise<ActionResult<{ id: string; case_id: string; max_id: string }>> {
  try {
    if (!t.title.trim()) return { ok: false, error: "Say what needs doing." };
    if (!customerId) return { ok: false, error: "Pick the customer first." };
    const me = await getMe();
    if (!me) return { ok: false, error: "Please log in again." };
    if (me.role !== "boss" && t.assigned_to !== me.id) return { ok: false, error: "Staff can only assign tasks to themselves." };
    const sb = await createClient();
    const { data, error } = await sb.rpc("create_task_with_case", {
      p_task: { title: t.title.trim(), assigned_to: t.assigned_to || me.id, due_at: t.due_at, priority: t.priority, alert: t.alert, notes: t.notes?.trim() || null },
      // the case goes to whoever does the task; its title and traveller are filled in by the database
      p_case: { customer_id: customerId, assigned_to: t.assigned_to || me.id },
      p_travellers: [],
      p_request_key: requestKey,
    });
    if (error) throw error;
    const r = data as { id: string; max_id: string; task_id: string };
    return { ok: true, data: { id: r.task_id, case_id: r.id, max_id: r.max_id }, message: `Task created on new case ${r.max_id}` };
  } catch (e) {
    return fail(e);
  }
}

/** What a finished task leaves behind: when it was the last open task on an open case, the screen asks for the next step. */
export type AfterDone = { needs_next: { id: string; max_id: string; title: string } | null };

export async function setTaskStatus(id: string, status: string): Promise<ActionResult<AfterDone>> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.from("tasks").update({ status }).eq("id", id).select("id, case_id");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "You can't change this task." };
    let needs_next: AfterDone["needs_next"] = null;
    const caseId = data[0].case_id as string | null;
    if (status === "done" && caseId) {
      const [{ count }, { data: c }] = await Promise.all([
        sb.from("tasks").select("id", { count: "exact", head: true }).eq("case_id", caseId).neq("status", "done"),
        sb.from("cases").select("id, max_id, title, status").eq("id", caseId).maybeSingle(),
      ]);
      if (c && !["completed", "cancelled"].includes(c.status) && (count ?? 0) === 0) needs_next = { id: c.id, max_id: c.max_id, title: c.title };
    }
    return { ok: true, data: { needs_next }, message: status === "done" ? "Task done" : "Task updated" };
  } catch (e) {
    return fail(e);
  }
}

const SNOOZE_DAYS: Record<string, number> = { tomorrow: 1, three_days: 3, next_week: 7 };

/** Move a task's due time to 10:00 (India time) tomorrow, in 3 days or in a week. The alert follows the new time. */
export async function snoozeTask(id: string, preset: string): Promise<ActionResult> {
  try {
    const days = SNOOZE_DAYS[preset];
    if (!days) return { ok: false, error: "Pick when to move it to." };
    const sb = await createClient();
    const due = new Date(`${todayIST(days)}T10:00:00+05:30`).toISOString();
    const { data, error } = await sb.from("tasks").update({ due_at: due }).eq("id", id).neq("status", "done").select("id");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "You can't change this task." };
    return { ok: true, message: `Moved to ${fdate(due)} 10:00` };
  } catch (e) {
    return fail(e);
  }
}

export async function addTaskComment(task_id: string, body: string): Promise<ActionResult> {
  try {
    if (!body.trim()) return { ok: false, error: "Write a comment first." };
    const me = await getMe();
    const sb = await createClient();
    const { error } = await sb.from("task_comments").insert({ task_id, body: body.trim(), author: me?.id });
    if (error) throw error;
    return { ok: true, message: "Comment added" };
  } catch (e) {
    return fail(e);
  }
}

export async function getTaskDetail(id: string) {
  const sb = await createClient();
  const [{ data: task }, { data: comments }] = await Promise.all([
    sb.from("tasks").select("*, case:cases(id, max_id, title, status), customer:customers(id, full_name, customer_type), assignee:profiles!tasks_assigned_to_fkey(full_name), completer:profiles!tasks_completed_by_fkey(full_name), creator:profiles!tasks_created_by_fkey(full_name)").eq("id", id).maybeSingle(),
    sb.from("task_comments").select("id, body, created_at, author:profiles(full_name)").eq("task_id", id).order("created_at"),
  ]);
  return { task, comments: comments ?? [] };
}

/** Existing MAX IDs for this customer (as payer or traveller) the user may open, so a duplicate trip isn't created. */
export async function suggestCases(customerId: string | null | undefined) {
  if (!customerId) return [];
  const sb = await createClient();
  const { data } = await sb.rpc("suggest_cases", { p_customer: customerId, p_limit: 8 });
  return (data ?? []) as { id: string; max_id: string; title: string; status: string; travel_start: string | null; relationship: string }[];
}

/** Link a task to a MAX ID. Moving an already-linked task needs a reason; both are recorded in the activity history. */
export async function linkTaskToCase(taskId: string, caseId: string, reason?: string): Promise<ActionResult<{ case_id: string; max_id: string }>> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.rpc("link_task_to_case", { p_task: taskId, p_case: caseId, p_reason: reason?.trim() || null });
    if (error) throw error;
    const r = data as { case_id: string; max_id: string; unchanged: boolean };
    return { ok: true, data: { case_id: r.case_id, max_id: r.max_id }, message: r.unchanged ? `Already on ${r.max_id}` : `Linked to ${r.max_id}` };
  } catch (e) {
    return fail(e);
  }
}

/** Make a new MAX ID from a task, with its travellers, and link the task, all in one transaction.
 *  Repeating it (double click, retry, second tab) returns the case made the first time. */
export async function createCaseFromTask(taskId: string, c: {
  customer_id: string; title: string; travel_start?: string | null; travel_end?: string | null; destination?: string | null;
  assigned_to?: string | null; lead_source?: string | null;
}, travellerIds: string[]): Promise<ActionResult<{ id: string; max_id: string }>> {
  try {
    if (!c.customer_id) return { ok: false, error: "Pick who the trip is for (the paying customer)." };
    if (!c.title?.trim()) return { ok: false, error: "Give the case a title." };
    const sb = await createClient();
    const { data, error } = await sb.rpc("create_case_from_task", {
      p_task: taskId,
      p_case: {
        customer_id: c.customer_id, title: c.title.trim(), travel_start: c.travel_start || null, travel_end: c.travel_end || null,
        destination: c.destination?.trim() || null, assigned_to: c.assigned_to || null, lead_source: c.lead_source || null,
      },
      p_travellers: Array.from(new Set(travellerIds.filter(Boolean))),
    });
    if (error) throw error;
    const r = data as { id: string; max_id: string; existing: boolean };
    return { ok: true, data: { id: r.id, max_id: r.max_id }, message: r.existing ? `This task already made ${r.max_id}` : `${r.max_id} created from the task` };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteTask(id: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.from("tasks").delete().eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "Only the boss can delete tasks. Mark it Done instead." };
    return { ok: true, message: "Task deleted" };
  } catch (e) {
    return fail(e);
  }
}
