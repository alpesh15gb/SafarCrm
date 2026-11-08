"use client";
import { useState } from "react";
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
  const [v, setV] = useState<{ id: string; label: string } | null>(sp.get("customer") ? { id: sp.get("customer")!, label: sp.get("cname") ?? "Selected customer" } : null);
  return (
    <div className="w-72">
      <CustomerPicker value={v} onChange={(o) => {
        setV(o);
        const p = new URLSearchParams(sp.toString());
        if (o) { p.set("customer", o.id); p.set("cname", o.label); } else { p.delete("customer"); p.delete("cname"); }
        router.replace(`${path}?${p}`, { scroll: false });
      }} />
    </div>
  );
}
