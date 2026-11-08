import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "./supabase/server";

export type Me = {
  id: string;
  role: "boss" | "staff" | "client";
  full_name: string;
  email: string | null;
  can_see_profit: boolean;
  can_see_all_cases: boolean;
  customer_id: string | null;
  must_change_password: boolean;
  mfa_pending: boolean;
};

export const getMe = cache(async (): Promise<Me | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getUser();
  if (!data.user) return null;
  const { data: p } = await supabase
    .from("profiles")
    .select("id, role, full_name, email, can_see_profit, can_see_all_cases, customer_id, must_change_password, active")
    .eq("id", data.user.id)
    .maybeSingle();
  if (!p || !p.active) return null;
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  const mfa_pending = !!aal && aal.nextLevel === "aal2" && aal.currentLevel !== "aal2";
  return { ...p, can_see_profit: p.role === "boss" || p.can_see_profit, mfa_pending } as Me;
});

export async function requireTeam() {
  const me = await getMe();
  if (!me) redirect("/login?e=inactive");
  if (me.mfa_pending) redirect("/login?mfa=1");
  if (me.must_change_password) redirect("/set-password");
  if (me.role === "client") redirect("/portal");
  return me;
}

export async function requireBoss() {
  const me = await requireTeam();
  if (me.role !== "boss") redirect("/dashboard");
  return me;
}

export async function requireClient() {
  const me = await getMe();
  if (!me) redirect("/login?e=inactive");
  if (me.mfa_pending) redirect("/login?mfa=1");
  if (me.must_change_password) redirect("/set-password");
  if (me.role !== "client") redirect("/dashboard");
  return me;
}

export type ActionResult<T = unknown> = { ok: true; data?: T; message?: string } | { ok: false; error: string };

export function fail(e: unknown): ActionResult<never> {
  const msg = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
  return { ok: false, error: friendly(msg) };
}

function friendly(msg: string) {
  if (msg.includes("row-level security")) return "You don't have permission to do that.";
  if (msg.includes("violates foreign key") && msg.includes("restrict")) return "This record is in use and can't be deleted.";
  if (msg.includes("violates foreign key")) return "This record is linked to other records and can't be deleted.";
  if (msg.includes("cancel_needs_reason")) return "Please give a reason for cancelling.";
  if (msg.includes("trip_dates_order")) return "The trip can't end before it starts. Check the travel dates.";
  return msg;
}
