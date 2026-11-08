"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { Button, Field } from "@/components/ui";

export function SetPasswordForm() {
  const router = useRouter();
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (a.length < 8) return setErr("Use at least 8 characters.");
        if (a !== b) return setErr("The two passwords don't match.");
        setBusy(true); setErr("");
        const sb = supabaseBrowser();
        const { error } = await sb.auth.updateUser({ password: a });
        if (error) { setErr(error.message); setBusy(false); return; }
        await sb.rpc("password_changed");
        router.replace("/");
        router.refresh();
      }}
    >
      <Field label="New password"><input className="field" type="password" autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} /></Field>
      <Field label="Repeat password"><input className="field" type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} /></Field>
      {err && <p className="text-sm text-red-600">{err}</p>}
      <Button type="submit" variant="primary" className="w-full" disabled={busy}>Save password</Button>
    </form>
  );
}
