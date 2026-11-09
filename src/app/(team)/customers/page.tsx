import Link from "next/link";
import { Download } from "lucide-react";
import { requireTeam } from "@/lib/auth";
import { listCustomers, PER_PAGE, type SP } from "@/lib/queries";
import { Badge, Card, Chips, Empty, LinkButton, PageHeader, Pager, Person, Table, btnClass } from "@/components/ui";
import { NewButton, SearchBox } from "@/components/list-tools";
import { expiryLabel, prettyPhone } from "@/lib/format";

export const metadata = { title: "Customers" };

export default async function CustomersPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireTeam();
  const sp = await searchParams;
  const { rows, count, page } = await listCustomers(sp);
  const qs = new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== "page") as [string, string][]).toString();
  const filtered = Object.keys(sp).some((k) => k !== "page" && sp[k]);
  return (
    <>
      <PageHeader title="Customers" sub={`One record per traveller, with every document · ${count} found`}
        action={<><a className={btnClass("secondary")} href={`/api/export?export=customers&${qs}`}><Download className="h-4 w-4" />Export to Excel</a><NewButton kind="customer" label="New customer" /></>} />
      <div className="mb-3 space-y-2">
        <SearchBox placeholder="Name, mobile, code, email, city or company" />
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <Chips param="type" current={sp.type} base={sp} allLabel="All types" items={[{ value: "individual", label: "Individual" }, { value: "family", label: "Family" }, { value: "corporate", label: "Corporate" }]} />
          <Chips param="tag" current={sp.tag} base={sp} allLabel="Any tag" items={["VIP", "Corporate", "Frequent"].map((t) => ({ value: t, label: t }))} />
          <Chips param="passport" current={sp.passport} base={sp} allLabel="Any passport" items={[{ value: "expiring", label: "Passport expiring in 6 months" }]} />
        </div>
      </div>
      <Card pad={false}>
        {rows.length === 0 ? (
          filtered ? <Empty text="No customers match." action={<LinkButton href="/customers">Clear filters</LinkButton>} />
            : <Empty text="No customers yet. Add your first traveller." action={<NewButton kind="customer" label="New customer" />} />
        ) : (
          <Table head={["Code", "Name", "Mobile", "City", "Tags", "Passport", "Cases"]}>
            {rows.map((r) => {
              const exp = expiryLabel(r.passport_expiry);
              return (
                <tr key={r.id} className="relative">
                  <td data-label="Code" className="font-mono text-[12.5px] font-semibold text-gray-500"><Link href={`/customers/${r.id}`} className="after:absolute after:inset-0">{r.code}</Link></td>
                  <td data-label="Name" className="font-medium"><Person name={r.full_name} sub={r.family?.name ?? r.email ?? undefined} size="md" /></td>
                  <td data-label="Mobile" className="whitespace-nowrap">{prettyPhone(r.mobile)}</td>
                  <td data-label="City">{r.city ?? "—"}</td>
                  <td data-label="Tags"><span className="flex flex-wrap justify-end gap-1 md:justify-start">{r.customer_type === "corporate" && <Badge tone="blue">Corporate</Badge>}{r.tags.filter((t) => !(t === "Corporate" && r.customer_type === "corporate")).map((t) => <Badge key={t} tone={t === "VIP" ? "coral" : "grey"}>{t}</Badge>)}</span></td>
                  <td data-label="Passport">{exp ? <Badge tone={exp.tone}>{exp.text}</Badge> : <span className="text-muted">—</span>}</td>
                  <td data-label="Cases"><span className="inline-flex min-w-7 justify-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold tabular">{r.cases?.[0]?.count ?? 0}</span></td>
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
