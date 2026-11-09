"use client";
import { useState } from "react";
import Link from "next/link";
import { Download, X } from "lucide-react";
import { Badge, Button, Card, Field, Table, btnClass, cx } from "@/components/ui";
import { Confirm, CopyButton, Dialog, Toggle, useAction } from "@/components/client";
import {
  addLookup, createStaff, deactivateStaff, reactivateStaff, removeLookup, resetStaffPassword, runRemindersNow, saveSettings, setMaxStart, updateStaff,
} from "@/actions/settings";
import { fdate } from "@/lib/format";

type S = Record<string, unknown> & { auto_reminders: Record<string, boolean>; portal_defaults: Record<string, boolean> };

export function GeneralTab({ settings, nextMax }: { settings: S; nextMax: number }) {
  const { run, pending } = useAction();
  const [v, setV] = useState({ agency_name: String(settings.agency_name ?? ""), agency_phone: String(settings.agency_phone ?? ""), agency_email: String(settings.agency_email ?? ""), agency_address: String(settings.agency_address ?? ""), app_url: String(settings.app_url ?? "") });
  const [start, setStart] = useState(String(nextMax));
  return (
    <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
      <Card title="Agency">
        <div className="space-y-3">
          <Field label="Agency name"><input className="field" value={v.agency_name} onChange={(e) => setV({ ...v, agency_name: e.target.value })} /></Field>
          <Field label="Phone"><input className="field" value={v.agency_phone} onChange={(e) => setV({ ...v, agency_phone: e.target.value })} /></Field>
          <Field label="Email"><input className="field" value={v.agency_email} onChange={(e) => setV({ ...v, agency_email: e.target.value })} /></Field>
          <Field label="Address"><textarea className="field" value={v.agency_address} onChange={(e) => setV({ ...v, agency_address: e.target.value })} /></Field>
          <Field label="Web address of this CRM" hint="Used in share links and portal invitations, e.g. https://crm.youragency.in"><input className="field" value={v.app_url} onChange={(e) => setV({ ...v, app_url: e.target.value })} /></Field>
          <div className="flex justify-end"><Button variant="primary" disabled={pending} onClick={() => run(() => saveSettings(v))}>Save</Button></div>
        </div>
      </Card>
      <Card title="MAX ID numbering">
        <p className="mb-3 text-[13px] text-muted">The next case will be <b className="font-mono text-ink">MAX-{nextMax}</b>. You can move the starting number forward (for example to continue from your old register). Numbers are never reused or edited.</p>
        <div className="flex gap-2">
          <input className="field !w-40 font-mono" inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value.replace(/\D/g, ""))} />
          <Button disabled={pending || Number(start) === nextMax} onClick={() => run(() => setMaxStart(Number(start)))}>Set next number</Button>
        </div>
      </Card>
    </div>
  );
}

type U = { id: string; full_name: string; email: string | null; role: string; active: boolean; can_see_profit: boolean; can_see_all_cases: boolean; created_at: string; open_cases: number };

export function UsersTab({ users, meId }: { users: U[]; meId: string }) {
  const { run, pending } = useAction();
  const [add, setAdd] = useState(false);
  const [nu, setNu] = useState({ full_name: "", email: "", phone: "", can_see_profit: false, can_see_all_cases: false });
  const [pw, setPw] = useState<{ name: string; email: string; password: string } | null>(null);
  const [deact, setDeact] = useState<U | null>(null);
  return (
    <div className="space-y-4">
      <Card title="Team" action={<Button size="sm" variant="primary" onClick={() => setAdd(true)}>Add staff login</Button>} pad={false}>
        <Table head={["Name", "Role", "Can see profit", "Can see all cases", "Open cases", "Status", ""]}>
          {users.map((u) => (
            <tr key={u.id} className={cx(!u.active && "text-muted")}>
              <td data-label="Name">{u.full_name}<div className="text-xs text-muted">{u.email}</div></td>
              <td data-label="Role">{u.role === "boss" ? "Boss" : "Staff"}</td>
              <td data-label="Can see profit">{u.role === "boss" ? "Always" : <Toggle checked={u.can_see_profit} disabled={pending || !u.active} onChange={(x) => run(() => updateStaff(u.id, { can_see_profit: x }))} />}</td>
              <td data-label="Can see all cases">{u.role === "boss" ? "Always" : <Toggle checked={u.can_see_all_cases} disabled={pending || !u.active} onChange={(x) => run(() => updateStaff(u.id, { can_see_all_cases: x }))} />}</td>
              <td data-label="Open cases">{u.open_cases}</td>
              <td data-label="Status"><Badge tone={u.active ? "green" : "grey"}>{u.active ? "Active" : "Deactivated"}</Badge></td>
              <td data-label="">
                {u.id !== meId && (
                  <span className="flex justify-end gap-1">
                    <Button size="sm" onClick={() => run(() => resetStaffPassword(u.id), { then: (r) => setPw({ name: u.full_name, email: u.email ?? "", password: (r.data as { password: string }).password }) })}>Reset password</Button>
                    {u.active ? <Button size="sm" variant="danger" onClick={() => setDeact(u)}>Deactivate</Button>
                      : <Button size="sm" onClick={() => run(() => reactivateStaff(u.id))}>Reactivate</Button>}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <p className="text-[13px] text-muted">By default staff see only cases assigned to them or created by them, and never see profit. Switch these on per person.</p>
      <Dialog open={add} onClose={() => setAdd(false)} title="Add staff login"
        footer={<><Button onClick={() => setAdd(false)}>Cancel</Button><Button variant="primary" disabled={pending}
          onClick={() => run(() => createStaff(nu), { then: (r) => { setAdd(false); setPw({ name: nu.full_name, email: nu.email, password: (r.data as { password: string }).password }); setNu({ full_name: "", email: "", phone: "", can_see_profit: false, can_see_all_cases: false }); } })}>Create login</Button></>}>
        <div className="space-y-3">
          <Field label="Full name" required><input className="field" value={nu.full_name} onChange={(e) => setNu({ ...nu, full_name: e.target.value })} /></Field>
          <Field label="Email (used to log in)" required><input className="field" type="email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} /></Field>
          <Field label="Mobile"><input className="field" value={nu.phone} onChange={(e) => setNu({ ...nu, phone: e.target.value })} /></Field>
          <Toggle checked={nu.can_see_profit} onChange={(x) => setNu({ ...nu, can_see_profit: x })} label="Can see profit, P&L and reports" />
          <Toggle checked={nu.can_see_all_cases} onChange={(x) => setNu({ ...nu, can_see_all_cases: x })} label="Can see all cases" />
        </div>
      </Dialog>
      <Dialog open={!!pw} onClose={() => setPw(null)} title="Temporary password" footer={<Button variant="primary" onClick={() => setPw(null)}>Done</Button>}>
        {pw && <div className="space-y-2 text-sm"><p>Give these to {pw.name}. They&apos;ll choose their own password when they first log in.</p>
          <div className="rounded-lg bg-gray-50 p-3">Login: <b>{pw.email}</b><br />Password: <b className="font-mono">{pw.password}</b> <CopyButton text={pw.password} /></div></div>}
      </Dialog>
      <Confirm open={!!deact} onClose={() => setDeact(null)} title={`Deactivate ${deact?.full_name}?`} confirmLabel="Deactivate" pending={pending}
        text={`They will no longer be able to log in. Their ${deact?.open_cases ?? 0} open case(s) and open tasks move to you.`}
        onConfirm={() => deact && run(() => deactivateStaff(deact.id), { then: () => setDeact(null) })} />
    </div>
  );
}

const PORTAL: [string, string][] = [
  ["show_case", "Show new cases in the portal"], ["show_bookings", "Show booking details"], ["show_files", "Show tickets and files marked visible"],
  ["show_payments", "Show payment summary"], ["show_line_prices", "Show price per line (otherwise the total only)"],
];

export function PortalTab({ settings }: { settings: S }) {
  const { run, pending } = useAction();
  const d = settings.portal_defaults;
  return (
    <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
      <Card title="Defaults for new cases">
        <div className="space-y-3">
          {PORTAL.map(([k, l]) => <Toggle key={k} label={l} checked={!!d[k]} disabled={pending} onChange={(x) => run(() => saveSettings({ portal_defaults: { ...d, [k]: x } }))} />)}
          <p className="text-xs text-muted">Each case can override these in its “Client view” panel; each booking and file has its own “Visible to client” switch.</p>
        </div>
      </Card>
      <Card title="Portal rules">
        <div className="space-y-3">
          <Toggle label="Hide cases until they are Confirmed" checked={!!settings.portal_hide_until_confirmed} disabled={pending} onChange={(x) => run(() => saveSettings({ portal_hide_until_confirmed: x }))} />
          <Toggle label="Let clients upload documents (they arrive as “Pending review”)" checked={!!settings.portal_allow_uploads} disabled={pending} onChange={(x) => run(() => saveSettings({ portal_allow_uploads: x }))} />
          <p className="text-xs text-muted">Clients never see supplier names, costs, commission, profit, internal notes, tasks or the activity log. Invite a client from their customer page.</p>
        </div>
      </Card>
    </div>
  );
}

const REMINDERS: [string, string, string][] = [
  ["passport_visa", "Passport or visa expiring", "6 months before expiry"],
  ["trip_upcoming", "Trip coming up (web check-in, final documents)", "2 days before travel"],
  ["client_due", "Client payment due", "On the due date, if a balance is left"],
  ["supplier_due", "Supplier payment due", "On the due date, from the supplier's credit days"],
  ["hotel_cancel", "Hotel free cancellation ending", "1 day before the deadline"],
  ["no_insurance", "International trip without insurance", "When the flight is saved"],
  ["birthday", "Customer birthday or anniversary", "On the day"],
];

export function RemindersTab({ settings }: { settings: S }) {
  const { run, pending } = useAction();
  const a = settings.auto_reminders;
  return (
    <Card title="Automatic reminders" className="max-w-3xl" action={<Button size="sm" disabled={pending} onClick={() => run(() => runRemindersNow())}>Check now</Button>}>
      <p className="mb-3 text-[13px] text-muted">These create tasks for the case&apos;s assigned staff every morning at 6:00 IST. Each reminder is created once.</p>
      <ul className="divide-y divide-line">
        {REMINDERS.map(([k, l, w]) => (
          <li key={k} className="flex items-center justify-between gap-3 py-2.5">
            <div><div className="text-sm">{l}</div><div className="text-xs text-muted">{w}</div></div>
            <Toggle checked={a[k] !== false} disabled={pending} onChange={(x) => run(() => saveSettings({ auto_reminders: { ...a, [k]: x } }))} />
          </li>
        ))}
      </ul>
    </Card>
  );
}

const KINDS: [string, string][] = [["airline", "Airlines"], ["hotel_chain", "Hotel chains"], ["insurer", "Insurers"], ["city", "Cities"], ["airport", "Airports"], ["lead_source", "Lead sources"], ["document_type", "Document types"]];

export function LookupsTab({ kind, items }: { kind: string; items: { id: string; value: string; extra: Record<string, string> }[] }) {
  const { run, pending } = useAction();
  const [v, setV] = useState("");
  const [city, setCity] = useState("");
  const [country, setCountry] = useState("IN");
  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {KINDS.map(([k, l]) => <Link key={k} href={`/settings?tab=lookups&kind=${k}`} className={cx("rounded-full border px-2.5 py-1 text-xs", k === kind ? "border-coral bg-coral-soft text-coral-dark" : "border-line bg-white text-muted")}>{l}</Link>)}
      </div>
      <Card>
        <div className="mb-3 flex flex-wrap gap-2">
          <input className="field !w-56" placeholder={kind === "airport" ? "IATA code, e.g. IXZ" : "Add a value"} value={v} onChange={(e) => setV(kind === "airport" ? e.target.value.toUpperCase().slice(0, 3) : e.target.value)} />
          {kind === "airport" && <><input className="field !w-40" placeholder="City" value={city} onChange={(e) => setCity(e.target.value)} /><input className="field !w-20" placeholder="Country" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))} /></>}
          <Button disabled={pending || !v.trim()} onClick={() => run(() => addLookup(kind, v, kind === "airport" ? { city, country } : {}), { then: () => { setV(""); setCity(""); } })}>Add</Button>
        </div>
        {kind === "airport" && <p className="mb-3 text-xs text-muted">Airports with country IN are treated as domestic; any other code makes a flight international (used for the insurance reminder).</p>}
        <div className="flex flex-wrap gap-1.5">
          {items.map((i) => (
            <span key={i.id} className="inline-flex items-center gap-1 rounded-full border border-line bg-white py-0.5 pl-2.5 pr-1 text-[13px]">
              {i.value}{i.extra?.city && <span className="text-muted">· {i.extra.city}{i.extra.country && i.extra.country !== "IN" ? `, ${i.extra.country}` : ""}</span>}
              <button type="button" aria-label={`Remove ${i.value}`} className="rounded-full p-0.5 text-muted hover:bg-gray-100 hover:text-red-600" onClick={() => run(() => removeLookup(i.id))}><X className="h-3 w-3" /></button>
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function DataTab() {
  return (
    <div className="grid max-w-4xl gap-4 lg:grid-cols-2">
      <Card title="Export all data">
        <p className="mb-3 text-[13px] text-muted">Download every customer, case, booking, payment, task and the activity log as one Excel workbook. ID numbers stay encrypted and are not included.</p>
        <a className={btnClass("primary")} href="/api/export?export=all"><Download className="h-4 w-4" />Export all data to Excel</a>
      </Card>
      <Card title="Backups">
        <p className="text-[13px] text-muted">The database is backed up automatically every day by Supabase (enable daily backups on your Supabase plan). Uploaded files live in private storage. Last checked {fdate(new Date().toISOString())}.</p>
      </Card>
    </div>
  );
}
