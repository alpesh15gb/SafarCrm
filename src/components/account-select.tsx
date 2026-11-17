"use client";
// "Received into" / "Paid from": which bank account, credit card, cash or UPI the money moved through
// (owner, 2026-11-18). Until the boss sets up accounts (Settings → Money accounts), the old mode list is shown.
import { useEffect, useState } from "react";
import { Field } from "@/components/ui";
import { listMoneyAccounts, type MoneyAccount } from "@/actions/money";
import { PAY_MODES } from "@/lib/constants";

export const accountLabel = (a: { name: string; kind: string; last4: string | null }) =>
  `${a.name}${a.last4 ? ` ••${a.last4}` : ""}`;

/** value = { account_id, mode }: picking an account sets its mode too (a cheque stays a cheque). */
export function AccountSelect({ label, value, onChange, allowCheque = true }: {
  label: string; value: { account_id: string; mode: string }; onChange: (v: { account_id: string; mode: string }) => void; allowCheque?: boolean;
}) {
  const [accounts, setAccounts] = useState<MoneyAccount[] | null>(null);
  useEffect(() => { listMoneyAccounts().then(setAccounts).catch(() => setAccounts([])); }, []);
  // only "Cash in hand" (or nothing) set up = the boss hasn't added accounts yet: the plain mode list stays
  const useAccounts = !!accounts && accounts.some((a) => a.kind !== "cash");
  // an account is always chosen: the one matching the form's usual mode, else the first
  useEffect(() => {
    if (!useAccounts || value.account_id || !accounts) return;
    const a = accounts.find((x) => x.kind === value.mode) ?? accounts[0];
    onChange({ account_id: a.id, mode: value.mode === "cheque" ? "cheque" : a.kind });
  }, [useAccounts]); // eslint-disable-line react-hooks/exhaustive-deps
  if (accounts === null) return <Field label={label}><select className="field" disabled><option>Loading…</option></select></Field>;
  if (!useAccounts) {
    return (
      <Field label="Mode">
        <select className="field" value={value.mode} onChange={(e) => onChange({ account_id: "", mode: e.target.value })}>
          {PAY_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </Field>
    );
  }
  const cheque = value.mode === "cheque";
  return (
    <Field label={label} hint={cheque ? "Cheque: pick the bank account it is paid into or drawn on." : undefined}>
      <select className="field" required value={value.account_id}
        onChange={(e) => { const a = accounts.find((x) => x.id === e.target.value); onChange({ account_id: e.target.value, mode: cheque ? "cheque" : a?.kind ?? value.mode }); }}>
        <option value="">Choose…</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{accountLabel(a)}</option>)}
      </select>
      {allowCheque && (
        <label className="mt-1 flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={cheque} onChange={(e) => {
            const a = accounts.find((x) => x.id === value.account_id);
            onChange({ ...value, mode: e.target.checked ? "cheque" : a?.kind ?? "bank" });
          }} />By cheque
        </label>
      )}
    </Field>
  );
}
