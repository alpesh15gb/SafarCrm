"use server";
import { createClient } from "@/lib/supabase/server";
import { fail, getMe, type ActionResult } from "@/lib/auth";

export type TaskInput = {
  id?: string;
  case_id: string | null;
  title: string;
  assigned_to: string;
  due_at: string | null;
  priority: string;
  alert: string;
  notes?: string | null;
  status?: string;
};

export async function saveTask(t: TaskInput): Promise<ActionResult<{ id: string }>> {
  try {
    if (!t.title.trim()) return { ok: false, error: "Give the task a title." };
    const me = await getMe();
    if (!me) return { ok: false, error: "Please log in again." };
    if (me.role !== "boss" && t.assigned_to !== me.id) return { ok: false, error: "Staff can only assign tasks to themselves." };
    const sb = await createClient();
    const row = {
      case_id: t.case_id || null, title: t.title.trim(), assigned_to: t.assigned_to || me.id, due_at: t.due_at, priority: t.priority,
      alert: t.due_at ? t.alert : "none", notes: t.notes?.trim() || null, ...(t.status ? { status: t.status } : {}),
    };
    if (t.id) {
      const { error } = await sb.from("tasks").update(row).eq("id", t.id);
      if (error) throw error;
      return { ok: true, data: { id: t.id }, message: "Task saved" };
    }
    const { data, error } = await sb.from("tasks").insert(row).select("id").single();
    if (error) throw error;
    return { ok: true, data, message: "Task created" };
  } catch (e) {
    return fail(e);
  }
}

export async function setTaskStatus(id: string, status: string): Promise<ActionResult> {
  try {
    const sb = await createClient();
    const { data, error } = await sb.from("tasks").update({ status }).eq("id", id).select("id");
    if (error) throw error;
    if (!data?.length) return { ok: false, error: "You can't change this task." };
    return { ok: true, message: status === "done" ? "Task done" : "Task updated" };
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
    sb.from("tasks").select("*, case:cases(id, max_id, title), customer:customers(full_name), assignee:profiles!tasks_assigned_to_fkey(full_name), completer:profiles!tasks_completed_by_fkey(full_name), creator:profiles!tasks_created_by_fkey(full_name)").eq("id", id).maybeSingle(),
    sb.from("task_comments").select("id, body, created_at, author:profiles(full_name)").eq("task_id", id).order("created_at"),
  ]);
  return { task, comments: comments ?? [] };
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
