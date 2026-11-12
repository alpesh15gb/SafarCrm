"use server";
import { createAdmin, createClient } from "@/lib/supabase/server";
import { fail, getMe, type ActionResult } from "@/lib/auth";

/** First login with a temporary password: the new password is set on the server, and only then is the "must change
 *  password" flag cleared. (Before, the browser cleared the flag itself, so the step could be skipped.) */
export async function setNewPassword(password: string): Promise<ActionResult> {
  try {
    const me = await getMe();
    if (!me) return { ok: false, error: "Please log in again." };
    if (password.length < 8) return { ok: false, error: "Use at least 8 characters." };
    const sb = await createClient();
    const { error } = await sb.auth.updateUser({ password });
    if (error) return { ok: false, error: error.message };
    const { error: pe } = await createAdmin().from("profiles").update({ must_change_password: false }).eq("id", me.id);
    if (pe) throw pe;
    return { ok: true, message: "Password saved" };
  } catch (e) {
    return fail(e);
  }
}
