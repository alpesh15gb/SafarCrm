import "server-only";
import { inr } from "@/lib/format";
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
  if (msg.includes("deleting this receipt")) return "Delete the refund first: removing this receipt would leave more refunded than the client paid.";
  if (msg.includes("refund_exceeds_received")) {
    const amt = Number(msg.match(/only ([\d.]+)/)?.[1] ?? 0);
    return `You can refund at most ${inr(amt)}, which is what the client has paid on this case. For a goodwill payment above that, add it as a case expense with a note.`;
  }
  if (msg.includes("trip_dates_order")) return "The trip can't end before it starts. Check the travel dates.";
  if (msg.includes("corporate_not_passenger")) return "A company can pay for a trip but can't be a traveller. Add the employees who travel instead.";
  if (msg.includes("traveller_not_on_case")) return "Add the person to the case's travellers first, then to the booking.";
  if (msg.includes("sector_arrival_date")) return `Check the flight dates: ${msg.split("sector_arrival_date:")[1]?.trim() ?? "the arrival date doesn't fit the departure date"}.`;
  if (msg.includes("sector_timezone")) return "One of the airports has an unknown time zone. Clear it or pick the airport again.";
  if (msg.includes("invalid_amount")) return `That amount isn't a number${msg.match(/"([^"]*)"/) ? `: “${msg.match(/"([^"]*)"/)![1]}”` : ""}. Use digits, e.g. 12500.`;
  if (msg.includes("cancel_blocked_confirmed")) return "This case has confirmed bookings. Cancel each one on the Bookings tab first, so refunds and supplier charges are recorded. Then cancel the case.";
  if (msg.includes("cancel_blocked_supplier_paid")) return "A supplier has already been paid on this case. Cancel each booking on the Bookings tab first and enter what the supplier refunds. Then cancel the case.";
  if (msg.includes("override_not_permitted")) return "Required work is still open (blocking tasks, ticket imports or documents). Only the boss can complete a case past that.";
  if (msg.includes("override_needs_reason")) return "Give a reason for completing with open items.";
  if (msg.includes("case_completion_direct")) return "Use Completed from the case page so open items are checked.";
  if (msg.includes("waiting_needs_reason")) return "Waiting needs a reason and a follow-up date and time.";
  if (msg.includes("relink_needs_reason")) return "This task is already linked to another MAX ID. Give a reason to move it.";
  if (msg.includes("import_version_conflict")) return "Someone else saved this import after you opened it. Reload to see their changes; your edits are kept on screen.";
  if (msg.includes("import_not_reviewable")) return "This import can't be changed in its current state.";
  if (msg.includes("import_incomplete")) return `Not ready to confirm: ${msg.split("import_incomplete:")[1]?.trim() ?? "some required fields are empty"}.`;
  if (msg.includes("comparison_required")) return "This booking already has tickets. Review the field-by-field comparison and tick that you checked it.";
  return msg;
}
