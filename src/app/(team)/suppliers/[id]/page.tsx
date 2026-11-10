import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTeam } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, Money, PageHeader, ServiceIcon, Stat, StatusBadge, Table, Tabs } from "@/components/ui";
import { ActivityList } from "@/components/activity";
import { PAY_MODE_LABEL, SERVICE_LABEL, SUPPLIER_TYPE_LABEL, type Service } from "@/lib/constants";
import { fdate, inr } from "@/lib/format";
import { DeleteSupplierPayment, SupplierForm, SupplierPayButton, SupplierFiles } from "./client";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sb = await createClient();
  const { data } = await sb.from("suppliers").select("name").eq("id", id).maybeSingle();
  return { title: data?.name ?? "Supplier" };
}

export default async function SupplierPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const me = await requireTeam();
  const { id } = await params;
  const { tab = "ledger" } = await searchParams;
  const sb = await createClient();
  const { data: s } = await sb.from("suppliers").select("*").eq("id", id).maybeSingle();
  if (!s) notFound();
  const [{ data: bal }, { data: owed }] = await Promise.all([
    sb.from("v_supplier_balance").select("payable, paid").eq("supplier_id", id).single(),
    sb.from("v_case_supplier_money").select("case_id, payable, paid, due_date, case:cases(max_id, title)").eq("supplier_id", id),
  ]);
  const payable = Number(bal?.payable ?? 0), paid = Number(bal?.paid ?? 0);
  const open = ((owed ?? []) as unknown as { case_id: string; payable: number; paid: number; due_date: string | null; case: { max_id: string; title: string } }[])
    .map((o) => ({ case_id: o.case_id, max_id: o.case.max_id, title: o.case.title, due: Number(o.payable) - Number(o.paid), due_date: o.due_date }))
    .filter((o) => o.due > 0);

  return (
    <>
      <PageHeader back={{ href: "/suppliers", label: "Suppliers" }} title={s.name}
        sub={<>{SUPPLIER_TYPE_LABEL[s.supplier_type] ?? s.supplier_type} · {s.terms === "credit" ? `Credit ${s.credit_days} days${s.credit_limit ? `, limit ${inr(s.credit_limit)}` : ""}` : "Prepaid"} · <StatusBadge status={s.status} /></>}
        action={<SupplierPayButton supplier={{ id: s.id, name: s.name }} open={open} />} />
      <div className="mb-4 grid grid-cols-3 gap-3">
        <Stat label="Payable" value={inr(payable)} />
        <Stat label="Paid" value={inr(paid)} />
        {payable - paid < 0
          ? <Stat label="Advance with supplier" value={inr(paid - payable)} sub="Paid ahead; it is used up as new bookings with this supplier are added" />
          : <Stat label="Due" value={inr(payable - paid)} sub={s.credit_limit && payable - paid > Number(s.credit_limit) ? "Over credit limit" : undefined} tone={payable - paid > 0 ? "red" : undefined} />}
      </div>
      <Tabs active={tab} base={`/suppliers/${id}`} tabs={[{ key: "ledger", label: "Ledger" }, { key: "details", label: "Details" }, { key: "files", label: "Files and notes" }, { key: "activity", label: "Activity" }]} />
      {tab === "ledger" && <Ledger id={id} isBoss={me.role === "boss" || me.can_see_all_cases} canDelete={me.role === "boss"} />}
      {tab === "details" && <div className="max-w-3xl"><SupplierForm supplier={s} /></div>}
      {tab === "files" && <FilesLoader id={id} notes={s.notes} isBoss={me.role === "boss"} />}
      {tab === "activity" && <ActivityLoader id={id} />}
    </>
  );
}

async function Ledger({ id, isBoss, canDelete }: { id: string; isBoss: boolean; canDelete: boolean }) {
  const sb = await createClient();
  const [{ data: lines }, { data: pays }] = await Promise.all([
    sb.from("booking_lines").select("id, service, summary, service_date, status, supplier_cost, refund_from_supplier, supplier_due_date, case:cases(id, max_id)").eq("supplier_id", id).order("created_at", { ascending: false }).limit(300),
    sb.from("payments").select("id, pay_date, amount, mode, reference, allocations:payment_allocations(amount, case:cases(id, max_id))").eq("supplier_id", id).eq("direction", "out").order("pay_date", { ascending: false }),
  ]);
  type L = { id: string; service: Service; summary: string | null; service_date: string | null; status: string; supplier_cost: number; refund_from_supplier: number; supplier_due_date: string | null; case: { id: string; max_id: string } };
  // a payment can cover a case this staff member may not open; the case then comes back empty
  type P = { id: string; pay_date: string; amount: number; mode: string; reference: string | null; allocations: { amount: number; case: { id: string; max_id: string } | null }[] };
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_420px]">
      <Card title="Bookings with this supplier" sub={isBoss ? undefined : "Your cases only. The totals above are for the whole agency."} pad={false}>
        {(lines ?? []).length === 0 ? <p className="p-4 text-sm text-muted">{isBoss ? "No bookings yet." : "None of your cases has a booking with this supplier yet."}</p> : (
          <Table head={["MAX ID", "Booking", "Date", "Payable", "Due by", "Status"]}>
            {((lines ?? []) as unknown as L[]).map((l) => (
              <tr key={l.id}>
                <td data-label="MAX ID" className="font-mono text-[13px] font-semibold"><Link className="hover:underline" href={`/cases/${l.case.id}?tab=payments`}>{l.case.max_id}</Link></td>
                <td data-label="Booking"><span className="inline-flex items-center gap-1.5"><ServiceIcon service={l.service} />{l.summary ?? SERVICE_LABEL[l.service]}</span></td>
                <td data-label="Date">{fdate(l.service_date) || "—"}</td>
                <td data-label="Payable"><Money value={l.status === "cancelled" ? l.supplier_cost - l.refund_from_supplier : l.supplier_cost} /></td>
                <td data-label="Due by">{fdate(l.supplier_due_date) || "—"}</td>
                <td data-label="Status"><StatusBadge status={l.status} /></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Payments made" pad={false}>
        {(pays ?? []).length === 0 ? <p className="p-4 text-sm text-muted">No payments yet.</p> : (
          <ul>
            {((pays ?? []) as unknown as P[]).map((p) => (
              <li key={p.id} className="border-b border-line px-4 py-2.5 text-sm last:border-0">
                <div className="flex items-center justify-between gap-2"><span>{fdate(p.pay_date)} · {PAY_MODE_LABEL[p.mode]}{p.reference && ` · ${p.reference}`}</span>
                  <span className="flex items-center gap-2"><Money value={p.amount} className="font-medium" />{canDelete && <DeleteSupplierPayment id={p.id} text={`${fdate(p.pay_date)} · ${inr(p.amount)} · ${PAY_MODE_LABEL[p.mode]}${p.reference ? ` · ${p.reference}` : ""}`} />}</span></div>
                {(() => {
                  const used = p.allocations.reduce((s, a) => s + Number(a.amount), 0);
                  const adv = Math.round((Number(p.amount) - used) * 100) / 100;
                  const parts = [...p.allocations.map((a) => `${a.case?.max_id ?? "another staff member's case"} (${inr(a.amount)})`), ...(adv > 0 ? [`advance ${inr(adv)}`] : [])];
                  return parts.length > 0 && <div className="text-xs text-muted">For {parts.join(", ")}</div>;
                })()}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

async function FilesLoader({ id, notes, isBoss }: { id: string; notes: string | null; isBoss: boolean }) {
  const sb = await createClient();
  const { data } = await sb.from("files").select("id, file_name, kind, created_at").eq("supplier_id", id).order("created_at", { ascending: false });
  return <SupplierFiles supplierId={id} files={data ?? []} notes={notes} isBoss={isBoss} />;
}

async function ActivityLoader({ id }: { id: string }) {
  const sb = await createClient();
  const { data } = await sb.from("activity_log").select("*").eq("supplier_id", id).order("created_at", { ascending: false }).limit(200);
  return <Card><ActivityList items={data ?? []} /></Card>;
}
