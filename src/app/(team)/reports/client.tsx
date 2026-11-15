"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui";
import { CustomerPicker } from "@/components/pickers";

export function PrintButton() {
  return <Button onClick={() => window.print()}><Printer className="h-4 w-4" />Print / PDF</Button>;
}

export function ReportCustomerFilter() {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const customerId = sp.get("customer");
  const value = customerId ? { id: customerId, label: sp.get("cname") ?? "Selected customer" } : null;
  return (
    <div className="w-72">
      <CustomerPicker key={customerId ?? "all"} value={value} onChange={(o) => {
        const p = new URLSearchParams(sp.toString());
        if (o) { p.set("customer", o.id); p.set("cname", o.label); } else { p.delete("customer"); p.delete("cname"); }
        router.replace(`${path}?${p}`, { scroll: false });
      }} />
    </div>
  );
}

export function ReportSupplierFilter({ suppliers }: { suppliers: { id: string; name: string }[] }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  return (
    <select aria-label="Supplier" value={sp.get("supplier") ?? ""} className="field !w-56" onChange={(e) => {
      const params = new URLSearchParams(sp.toString());
      if (e.target.value) params.set("supplier", e.target.value);
      else params.delete("supplier");
      router.replace(`${path}?${params}`, { scroll: false });
    }}>
      <option value="">All suppliers</option>
      {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}
    </select>
  );
}
