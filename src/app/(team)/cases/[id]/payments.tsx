"use client";
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Badge, Button, Card, Field, Money, ServiceIcon, Table, cx } from "@/components/ui";
import { Dialog, useAction } from "@/components/client";
import { StaffSelect } from "@/components/pickers";
import { useApp } from "@/components/shell/shell";
import { addClientPayment, addExpense, addSupplierPayment, deleteExpense, deletePayment } from "@/actions/money";
import { PAY_MODES, PAY_MODE_LABEL, SERVICE_LABEL } from "@/lib/constants";
import { fdate, todayIST, inr } from "@/lib/format";
import type { Line } from "./bookings";

type Pay = { id: string; pay_date: string; amount: number; mode: string; reference: string | null; notes: string | null; receiver: { full_name: string } | null };
type Exp = { id: string; name: string; amount: number; exp_date: string };
type SupMoney = { supplier_id: string; supplier_name: string; payable: number; paid: number; due_date: string | null };
type SupPay = { amount: number; payment: { id: string; pay_date: string; mode: string; reference: string | null; supplier: { name: string } | null } };

export function PaymentsTab({ caseId, lines, money, payments, expenses, suppliers, supplierPayments, status }: {
  status: string; caseId: string; lines: Line[]; money: Record<string, unknown> | null; payments: Pay[]; expenses: Exp[]; suppliers: SupMoney[]; supplierPayments: SupPay[];
}) {
  const { me } = useApp();
  const { run, pending } = useAction();
  const [payOpen, setPayOpen] = useState(false);
  const [supPay, setSupPay] = useState<SupMoney | null>(null);
  const [exp, setExp] = useState({ name: "", amount: "" });

  const tot = lines.reduce(
    (a, l) => ({
      cost: a.cost + Number(l.money?.cost ?? 0), sale: a.sale + Number(l.money?.sale ?? 0),
      commission: a.commission + (l.status === "cancelled" ? 0 : Number(l.commission_amount)), profit: a.profit + Number(l.money?.profit ?? 0),
    }),
    { cost: 0, sale: 0, commission: 0, profit: 0 },
  );
  const expTotal = expenses.reduce((s, e) => s + Number(e.amount), 0);

  return (
    <div className="space-y-4">
      {me.can_see_profit && (
        <Card title="Profit and loss" pad={false}>
          <Table
            head={["Service", "Supplier", "Cost", "Selling price", "Commission", "Profit", "Margin"]}
            foot={
              <>
                <tr>
                  <td data-label="" colSpan={2}>Bookings total</td>
                  <td data-label="Cost"><Money value={tot.cost} /></td>
                  <td data-label="Selling price"><Money value={tot.sale} /></td>
                  <td data-label="Commission"><Money value={tot.commission} /></td>
                  <td data-label="Profit"><Money value={tot.profit} profit /></td>
                  <td data-label="Margin">{tot.sale ? `${Math.round((tot.profit / tot.sale) * 1000) / 10}%` : "—"}</td>
                </tr>
                {expTotal > 0 && (
                  <tr><td data-label="" colSpan={5}>Less case expenses</td><td data-label="Expenses"><Money value={-expTotal} /></td><td data-label="" /></tr>
                )}
                <tr className="text-base">
                  <td data-label="" colSpan={5}>Case profit</td>
                  <td data-label="Case profit"><span className="flex items-center gap-1.5"><Money value={money?.profit as number} profit />{Number(money?.profit) < 0 && <Badge tone="red">Loss</Badge>}</span></td>
                  <td data-label="Margin">{money?.margin != null ? `${money.margin}%` : "—"}</td>
                </tr>
              </>
            }
          >
            {lines.map((l) => (
              <tr key={l.id} className={l.status === "cancelled" ? "text-muted" : ""}>
                <td data-label="Service"><span className="inline-flex items-center gap-1.5"><ServiceIcon service={l.service} />{SERVICE_LABEL[l.service]}{l.status === "cancelled" && <Badge tone="red">Cancelled</Badge>}</span><div className="text-xs text-muted">{l.summary}</div></td>
                <td data-label="Supplier">{l.supplier?.name ?? "—"}</td>
                <td data-label="Cost"><Money value={l.money?.cost} /></td>
                <td data-label="Selling price"><Money value={l.money?.sale} /></td>
                <td data-label="Commission"><Money value={l.status === "cancelled" ? 0 : l.commission_amount} /></td>
                <td data-label="Profit"><Money value={l.money?.profit} profit /></td>
                <td data-label="Margin">{l.money?.margin != null ? `${l.money.margin}%` : "—"}</td>
              </tr>
            ))}
          </Table>
          <div className="border-t border-line p-4">
            <div className="mb-2 text-sm font-medium">Case expenses <span className="font-normal text-muted">(courier, card charges, visa fees paid; these reduce profit)</span></div>
            {expenses.map((e) => (
              <div key={e.id} className="flex items-center justify-between border-b border-line py-1.5 text-sm last:border-0">
                <span>{e.name} <span className="text-xs text-muted">· {fdate(e.exp_date)}</span></span>
                <span className="flex items-center gap-2"><Money value={e.amount} />{me.role === "boss" && <button type="button" className="text-muted hover:text-red-600" aria-label="Delete expense" onClick={() => run(() => deleteExpense(e.id))}><Trash2 className="h-3.5 w-3.5" /></button>}</span>
              </div>
            ))}
            <div className="mt-2 flex flex-wrap gap-2">
              <input className="field !w-56" placeholder="Expense name" value={exp.name} onChange={(e) => setExp({ ...exp, name: e.target.value })} />
              <input className="field !w-32 tabular" placeholder="₹" inputMode="decimal" value={exp.amount} onChange={(e) => setExp({ ...exp, amount: e.target.value })} />
              <Button disabled={pending || !exp.name || !exp.amount} onClick={() => run(() => addExpense(caseId, exp.name, Number(exp.amount)), { then: () => setExp({ name: "", amount: "" }) })}>Add expense</Button>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="From client" action={<Button size="sm" variant="primary" onClick={() => setPayOpen(true)}><Plus className="h-3.5 w-3.5" />Record payment</Button>} pad={false}>
          <div className="grid grid-cols-3 gap-2 border-b border-line p-4 text-center">
            <div><div className="text-xs text-muted">Billed (incl. GST)</div><Money value={money?.billed as number} className="font-semibold" /></div>
            <div><div className="text-xs text-muted">Received</div><Money value={money?.received as number} className="font-semibold text-emerald-700" /></div>
            <div><div className="text-xs text-muted">{Number(money?.due) < 0 ? "Client credit" : "Due"}</div><Money value={Math.abs(Number(money?.due ?? 0))} className={Number(money?.due) > 0 ? "font-semibold text-amber-700" : "font-semibold"} /></div>
          </div>
          {payments.length === 0 ? <p className="p-4 text-sm text-muted">No payments received yet.</p> : (
            <Table head={["Date", "Amount", "Mode", "Reference", "Received by", ""]}>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td data-label="Date">{fdate(p.pay_date)}</td>
                  <td data-label="Amount"><Money value={p.amount} />{Number(p.amount) < 0 && <Badge className="ml-1">Refund</Badge>}</td>
                  <td data-label="Mode">{PAY_MODE_LABEL[p.mode]}</td>
                  <td data-label="Reference">{p.reference ?? "—"}</td>
                  <td data-label="Received by">{p.receiver?.full_name ?? "—"}</td>
                  <td data-label="">{me.role === "boss" && <button type="button" aria-label="Delete payment" className="text-muted hover:text-red-600" onClick={() => run(() => deletePayment(p.id))}><Trash2 className="h-3.5 w-3.5" /></button>}</td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="To suppliers" pad={false}>
          <div className="grid grid-cols-3 gap-2 border-b border-line p-4 text-center">
            <div><div className="text-xs text-muted">Payable</div><Money value={money?.supplier_payable as number} className="font-semibold" /></div>
            <div><div className="text-xs text-muted">Paid</div><Money value={money?.supplier_paid as number} className="font-semibold text-emerald-700" /></div>
            {Number(money?.supplier_due) < 0
              ? <div><div className="text-xs text-muted">Advance</div><Money value={-Number(money?.supplier_due)} className="font-semibold text-sky-700" /></div>
              : <div><div className="text-xs text-muted">Due</div><Money value={money?.supplier_due as number} className={Number(money?.supplier_due) > 0 ? "font-semibold text-amber-700" : "font-semibold"} /></div>}
          </div>
          {(() => {
            // cost on bookings that have no supplier can't be paid from here; say so plainly
            const orphan = lines.filter((l) => !l.supplier_id && l.status !== "cancelled" && Number(l.supplier_cost) > 0);
            const amt = orphan.reduce((a, l) => a + Number(l.supplier_cost), 0);
            return orphan.length > 0 ? (
              <p className="mx-4 mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
                {inr(amt)} of cost has no supplier ({orphan.map((l) => l.summary || l.service).join(", ")}). Open the Bookings tab, press Edit and choose who we pay.
              </p>
            ) : null;
          })()}
          {suppliers.length === 0 ? <p className="p-4 text-sm text-muted">No supplier payments yet.</p> : (
            <Table head={["Supplier", "Payable", "Paid", "Due", ""]}>
              {suppliers.map((s) => {
                const due = Number(s.payable) - Number(s.paid);
                return (
                  <tr key={s.supplier_id}>
                    <td data-label="Supplier">{s.supplier_name}{s.due_date && due > 0 && <div className="text-xs text-muted">due {fdate(s.due_date)}</div>}</td>
                    <td data-label="Payable"><Money value={s.payable} /></td>
                    <td data-label="Paid"><Money value={s.paid} /></td>
                    <td data-label="Due">{due < 0
                      ? <span className="text-sky-700" title="Paid more than this booking costs; stays as an advance with the supplier">Advance <Money value={-due} /></span>
                      : <Money value={due} className={due > 0 ? "text-amber-700" : ""} />}</td>
                    <td data-label="">{due > 0 && <Button size="sm" onClick={() => setSupPay(s)}>Pay</Button>}</td>
                  </tr>
                );
              })}
            </Table>
          )}
          {supplierPayments.length > 0 && (
            <div className="border-t border-line px-4 py-3 text-xs text-muted">
              {supplierPayments.map((a, i) => (
                <div key={i}>{fdate(a.payment.pay_date)} · {a.payment.supplier?.name} · <Money value={a.amount} /> · {PAY_MODE_LABEL[a.payment.mode]}{a.payment.reference && ` · ${a.payment.reference}`}</div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <ClientPaymentDialog open={payOpen} onClose={() => setPayOpen(false)} caseId={caseId} due={Number(money?.due ?? 0)} received={Number(money?.received ?? 0)} status={status} />
      <SupplierPaymentDialog sup={supPay} onClose={() => setSupPay(null)} caseId={caseId} />
    </div>
  );
}

function ClientPaymentDialog({ open, onClose, caseId, due, received, status }: { open: boolean; onClose: () => void; caseId: string; due: number; received: number; status: string }) {
  const { me, staff } = useApp();
  const { run, pending } = useAction();
  const [v, setV] = useState({ pay_date: todayIST(), amount: "", mode: "upi", reference: "", received_by: me.id, notes: "", refund: false });
  const amt = Number(String(v.amount).replace(/[,\s₹]/g, ""));
  // typing a minus sign is the same as ticking "refund"
  const isRefund = v.refund || amt < 0;
  const abs = Math.abs(amt) || 0;
  const over = !isRefund && due > 0 && abs > due;
  const refundable = Math.max(0, received);
  const tooMuchRefund = isRefund && abs > refundable;
  return (
    <Dialog open={open} onClose={onClose} title={isRefund ? "Record refund to client" : "Record payment from client"}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={pending || !abs || tooMuchRefund}
        onClick={() => run(() => addClientPayment({ ...v, case_id: caseId, amount: (isRefund ? -1 : 1) * abs }), { then: () => { onClose(); setV({ ...v, amount: "", reference: "", notes: "", refund: false }); } })}>{isRefund ? "Save refund" : "Save payment"}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount (₹)" required hint={due > 0 ? `Balance due ${inr(due)}` : undefined}>
          <input className="field tabular" autoFocus inputMode="decimal" value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} />
        </Field>
        <Field label="Date"><input type="date" className="field" value={v.pay_date} onChange={(e) => setV({ ...v, pay_date: e.target.value })} /></Field>
        <Field label="Mode"><select className="field" value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })}>{PAY_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
        <Field label="Reference no."><input className="field" value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} placeholder="UTR / cheque no." /></Field>
        <Field label="Received by"><StaffSelect staff={staff} value={v.received_by} onChange={(x) => setV({ ...v, received_by: x })} /></Field>
        <Field label="Notes"><input className="field" value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} /></Field>
        {["enquiry", "quoted"].includes(status) && !isRefund && (
          <p className="rounded-lg bg-sky-50 px-3 py-2 text-[13px] text-sky-900 sm:col-span-2">
            This case is still {status === "enquiry" ? "an Enquiry" : "Quoted"}. If the client is paying, they have agreed: change the case status to <b>Confirmed</b> at the top of the page.
          </p>
        )}
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={isRefund} disabled={amt < 0} onChange={(e) => setV({ ...v, refund: e.target.checked })} />This is a refund paid back to the client</label>
        {abs > 0 && (
          <p className={cx("rounded-lg px-3 py-2 text-[13px] sm:col-span-2", tooMuchRefund ? "bg-red-50 font-medium text-red-700" : isRefund ? "bg-amber-50 text-amber-900" : over ? "bg-amber-50 text-amber-900" : "bg-emerald-50 text-emerald-900")}>
            {isRefund ? (tooMuchRefund
              ? `The client has paid ${inr(refundable)} on this case, so that is the most you can refund. For a goodwill payment above that, add it as a case expense with a note.`
              : `${inr(abs)} will be recorded as money paid BACK to the client (refundable: ${inr(refundable)}).`)
              : over ? `This is ${inr((abs - due))} more than the balance due (${inr(due)}). Check the amount, or save if the client paid extra.`
                : `${inr(abs)} received from the client. Balance after this: ${inr(Math.max(0, due - abs))}.`}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function SupplierPaymentDialog({ sup, onClose, caseId }: { sup: SupMoney | null; onClose: () => void; caseId: string }) {
  const { run, pending } = useAction();
  const due = sup ? Number(sup.payable) - Number(sup.paid) : 0;
  const [v, setV] = useState({ pay_date: todayIST(), amount: "", mode: "bank", reference: "" });
  if (!sup) return null;
  const amt = Number(v.amount || due);
  const extra = Math.round((amt - Math.max(due, 0)) * 100) / 100;
  return (
    <Dialog open={!!sup} onClose={onClose} title={`Pay ${sup.supplier_name}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={pending}
        onClick={() => { const amt = Number(v.amount || due); run(() => addSupplierPayment({ supplier_id: sup.supplier_id, pay_date: v.pay_date, amount: amt, mode: v.mode, reference: v.reference, allocations: [{ case_id: caseId, amount: amt }] }), { then: onClose }); }}>Save payment</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount (₹)" hint={`Due on this case ${inr(due)}`}><input className="field tabular" inputMode="decimal" placeholder={String(due)} value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} /></Field>
        <Field label="Date"><input type="date" className="field" value={v.pay_date} onChange={(e) => setV({ ...v, pay_date: e.target.value })} /></Field>
        <Field label="Mode"><select className="field" value={v.mode} onChange={(e) => setV({ ...v, mode: e.target.value })}>{PAY_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</select></Field>
        <Field label="Reference no."><input className="field" value={v.reference} onChange={(e) => setV({ ...v, reference: e.target.value })} /></Field>
      </div>
      {extra > 0 && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          This is {inr(extra)} more than is due on this case ({inr(Math.max(due, 0))}). Check the amount. If you are paying in advance, save it: the extra shows as an advance with {sup.supplier_name}.
        </p>
      )}
      <p className="mt-3 text-xs text-muted">To pay for several MAX IDs at once, use “Record payment” on the supplier page.</p>
    </Dialog>
  );
}
