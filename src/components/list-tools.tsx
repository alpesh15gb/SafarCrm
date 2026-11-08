"use client";
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { Button } from "./ui";
import { useApp } from "./shell/shell";

export function SearchBox({ placeholder }: { placeholder: string }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");
  useEffect(() => {
    const h = setTimeout(() => {
      if ((sp.get("q") ?? "") === q) return;
      const p = new URLSearchParams(sp.toString());
      if (q) p.set("q", q); else p.delete("q");
      p.delete("page");
      router.replace(`${path}?${p}`, { scroll: false });
    }, 300);
    return () => clearTimeout(h);
  }, [q, sp, path, router]);
  return (
    <div className="relative w-full max-w-sm">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
      <input className="field pl-9" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
    </div>
  );
}

export function NewButton({ kind, label, preset, variant = "primary", className }: { kind: "case" | "task" | "customer" | "supplier"; label: string; preset?: Record<string, unknown>; variant?: "primary" | "secondary"; className?: string }) {
  const { openNew } = useApp();
  return (
    <Button variant={variant} className={className} onClick={() => openNew(kind, preset)}>
      <Plus className="h-4 w-4" />{label}
    </Button>
  );
}
