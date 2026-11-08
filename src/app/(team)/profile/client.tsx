"use client";
import { useEffect, useState } from "react";
import { Badge, Button, Card, Field } from "@/components/ui";
import { useToast } from "@/components/client";
import { supabaseBrowser } from "@/lib/supabase/browser";

export function ProfileClient({ isBoss }: { isBoss: boolean }) {
  const toast = useToast();
  const sb = supabaseBrowser();
  const [pw, setPw] = useState({ a: "", b: "" });
  const [factors, setFactors] = useState<{ id: string; status: string; friendly_name?: string }[]>([]);
  const [enrol, setEnrol] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");

  const load = async () => { const { data } = await sb.auth.mfa.listFactors(); setFactors((data?.all ?? []).filter((f: { factor_type: string }) => f.factor_type === "totp")); };
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const verified = factors.some((f) => f.status === "verified");

  return (
    <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
      <Card title="Change password">
        <div className="space-y-3">
          <Field label="New password"><input type="password" className="field" autoComplete="new-password" value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} /></Field>
          <Field label="Repeat password"><input type="password" className="field" autoComplete="new-password" value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} /></Field>
          <Button variant="primary" onClick={async () => {
            if (pw.a.length < 8) return toast("Use at least 8 characters.", "error");
            if (pw.a !== pw.b) return toast("The passwords don't match.", "error");
            const { error } = await sb.auth.updateUser({ password: pw.a });
            if (error) return toast(error.message, "error");
            setPw({ a: "", b: "" }); toast("Password changed");
          }}>Save password</Button>
        </div>
      </Card>
      <Card title={<span className="flex items-center gap-2">Two-step login {verified ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}</span>}>
        <p className="mb-3 text-[13px] text-muted">
          After your password, you&apos;ll also enter a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator).
          {isBoss && " Recommended for the boss account, which can see everything."}
        </p>
        {verified ? (
          <Button variant="danger" onClick={async () => {
            for (const f of factors) await sb.auth.mfa.unenroll({ factorId: f.id });
            await load(); toast("Two-step login switched off");
          }}>Switch off</Button>
        ) : enrol ? (
          <div className="space-y-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={enrol.qr} alt="Scan with your authenticator app" className="h-44 w-44 rounded border border-line" />
            <p className="text-xs text-muted">Can&apos;t scan? Enter this key: <span className="font-mono">{enrol.secret}</span></p>
            <Field label="Code from the app"><input className="field !w-40 tracking-widest" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <Button variant="primary" onClick={async () => {
              const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: enrol.id, code });
              if (error) return toast("That code didn't work. Try again.", "error");
              setEnrol(null); setCode(""); await load(); toast("Two-step login is on");
            }}>Verify and switch on</Button>
          </div>
        ) : (
          <Button onClick={async () => {
            for (const f of factors.filter((x) => x.status !== "verified")) await sb.auth.mfa.unenroll({ factorId: f.id });
            const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `Safar ${Date.now()}` });
            if (error || !data) return toast(error?.message ?? "Could not start", "error");
            setEnrol({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
          }}>Set up two-step login</Button>
        )}
      </Card>
    </div>
  );
}
