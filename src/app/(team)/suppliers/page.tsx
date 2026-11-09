import Link from "next/link";
import { Download } from "lucide-react";
import { requireTeam } from "@/lib/auth";
import { listSuppliers, PER_PAGE, type SP } from "@/lib/queries";
import { Card, Chips, Empty, LinkButton, Money, PageHeader, Pager, ServiceIcon, StatusBadge, Table, btnClass } from "@/components/ui";
import { NewButton, SearchBox } from "@/components/list-tools";
import { SERVICES, SERVICE_LABEL, SUPPLIER_TYPES, SUPPLIER_TYPE_LABEL } from "@/lib/constants";
import { prettyPhone } from "@/lib/format";

export const metadata = { title: "Suppliers" };

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireTeam();
  const sp = await searchParams;
  const { rows, count, page } = await listSuppliers(sp);
  const qs = new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== "page") as [string, string][]).toString();
  const filtered = Object.keys(sp).some((k) => k !== "page" && sp[k]);
  return (
    <>
      <PageHeader title="Suppliers" sub="Who we buy from, and what we owe them."
        action={<><a className={btnClass("secondary")} href={`/api/export?export=suppliers&${qs}`}><Download className="h-4 w-4" />Export to Excel</a><NewButton kind="supplier" label="New supplier" /></>} />
      <div className="mb-3 space-y-2">
        <SearchBox placeholder="Supplier name" />
        <Chips param="type" current={sp.type} base={sp} allLabel="All types" items={SUPPLIER_TYPES} />
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <Chips param="service" current={sp.service} base={sp} allLabel="All services" items={SERVICES.filter((s) => s !== "other").map((s) => ({ value: s, label: SERVICE_LABEL[s] }))} />
          <Chips param="status" current={sp.status} base={sp} allLabel="Any status" items={[{ value: "active", label: "Active" }, { value: "inactive", label: "Inactive" }]} />
        </div>
      </div>
      <Card pad={false}>
        {rows.length === 0 ? (
          filtered ? <Empty text="No suppliers match." action={<LinkButton href="/suppliers">Clear filters</LinkButton>} />
            : <Empty text="No suppliers yet. Add the consolidators, hotels and insurers you book with." action={<NewButton kind="supplier" label="New supplier" />} />
        ) : (
          <Table head={["Supplier", "Type", "Services", "Contact", "Terms", "We owe", "Status"]}>
            {rows.map((r) => {
              const due = r.payable - r.paid;
              return (
                <tr key={r.id} className="relative">
                  <td data-label="Supplier" className="font-medium"><Link href={`/suppliers/${r.id}`} className="inline-flex items-center gap-2.5 after:absolute after:inset-0"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-linear-to-br from-slate-100 to-slate-200 text-xs font-bold text-slate-600 ring-1 ring-inset ring-black/5">{r.name.slice(0, 2).toUpperCase()}</span>{r.name}</Link></td>
                  <td data-label="Type">{SUPPLIER_TYPE_LABEL[r.supplier_type] ?? r.supplier_type}</td>
                  <td data-label="Services"><span className="inline-flex gap-1">{(r.services as string[]).map((s) => <span key={s} className="flex h-6 w-6 items-center justify-center rounded-md bg-gray-100 text-gray-600"><ServiceIcon service={s} className="h-3.5 w-3.5" /></span>)}</span></td>
                  <td data-label="Contact">{r.contact_person ?? ""}{r.mobile && <div className="text-xs text-muted">{prettyPhone(r.mobile)}</div>}</td>
                  <td data-label="Terms">{r.terms === "credit" ? `Credit ${r.credit_days} days` : "Prepaid"}</td>
                  <td data-label="We owe">{due < 0 ? <span className="text-sky-700">Advance <Money value={-due} /></span> : due ? <Money value={due} className="text-amber-700" /> : <span className="text-muted">—</span>}</td>
                  <td data-label="Status"><StatusBadge status={r.status} /></td>
                </tr>
              );
            })}
          </Table>
        )}
        <Pager page={page} total={count} perPage={PER_PAGE} base={sp} />
      </Card>
    </>
  );
}
