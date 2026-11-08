"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { Button, Field } from "@/components/ui";
import { portalCodeEmail, portalEmail } from "@/lib/format";

export function LoginForm({ mfa }: { mfa: boolean }) {
  const router = useRouter();
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"pw" | "mfa">(mfa ? "mfa" : "pw");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const sb = supabaseBrowser();

  useEffect(() => { if (mfa) setStep("mfa"); }, [mfa]);

  async function afterPassword() {
    const { data } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (data && data.nextLevel === "aal2" && data.currentLevel !== "aal2") { setStep("mfa"); return; }
    router.replace("/");
    router.refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      if (step === "pw") {
        const t = id.trim();
        const email = t.includes("@") ? t : /^c-?\d+$/i.test(t) ? portalCodeEmail(t) : portalEmail(t);
        const { error } = await sb.auth.signInWithPassword({ email, password: pw });
        if (error) throw new Error(error.message === "Invalid login credentials" ? "Wrong email/mobile or password." : error.message);
        await afterPassword();
      } else {
        const { data: f } = await sb.auth.mfa.listFactors();
        const factor = f?.totp?.[0];
        if (!factor) throw new Error("No authenticator found for this login.");
        const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
        if (error) throw new Error("That code didn't work. Try the latest code from your app.");
        router.replace("/");
        router.refresh();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not log in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {step === "pw" ? (
        <>
          <Field label="Email or mobile number">
            <input className="field !h-10" autoFocus autoComplete="username" value={id} onChange={(e) => setId(e.target.value)} required />
          </Field>
          <Field label="Password">
            <input className="field !h-10" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
          </Field>
        </>
      ) : (
        <Field label="6-digit code from your authenticator app">
          <input className="field tracking-widest" autoFocus inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
        </Field>
      )}
      {err && <p className="text-sm text-red-600">{err}</p>}
      <Button type="submit" variant="primary" className="h-10 w-full text-[15px]" disabled={busy}>
        {busy ? "Please wait…" : step === "pw" ? "Log in" : "Verify"}
      </Button>
    </form>
  );
}
