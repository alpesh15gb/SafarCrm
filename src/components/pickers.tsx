"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, X } from "lucide-react";
import { cx } from "./ui";
import { searchCases, searchCustomers, searchSuppliers } from "@/actions/search";
import { prettyPhone } from "@/lib/format";

type Opt = { id: string; label: string; sub?: string; raw?: unknown };

export function Combo({
  value, onChange, search, placeholder = "Search…", footer, autoFocus, disabled,
}: {
  value: Opt | null;
  onChange: (o: Opt | null) => void;
  search: (q: string) => Promise<Opt[]>;
  placeholder?: string;
  footer?: (q: string, close: () => void) => ReactNode;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState<Opt[]>([]);
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef(search);
  useEffect(() => { searchRef.current = search; });

  useEffect(() => {
    if (!open) return;
    const h = setTimeout(async () => { setOpts(await searchRef.current(q)); setSel(0); }, 180);
    return () => clearTimeout(h);
  }, [q, open]);
  useEffect(() => {
    const m = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", m);
    return () => document.removeEventListener("mousedown", m);
  }, []);

  const pick = (o: Opt) => { onChange(o); setOpen(false); setQ(""); };

  return (
    <div ref={ref} className="relative">
      {value && !open ? (
        <div className={cx("field flex items-center justify-between gap-2", disabled && "bg-gray-50")}>
          <button type="button" disabled={disabled} className="min-w-0 flex-1 truncate text-left" onClick={() => setOpen(true)}>
            {value.label} {value.sub && <span className="text-muted">· {value.sub}</span>}
          </button>
          {!disabled && (
            <button type="button" onClick={() => onChange(null)} className="text-muted hover:text-ink" aria-label="Clear"><X className="h-4 w-4" /></button>
          )}
        </div>
      ) : (
        <div className="relative">
          <input
            className="field pr-8"
            autoFocus={autoFocus || open}
            placeholder={placeholder}
            value={q}
            disabled={disabled}
            onFocus={() => setOpen(true)}
            onChange={(e) => { setQ(e.target.value); setOpen(true); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, opts.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              if (e.key === "Enter" && opts[sel]) { e.preventDefault(); pick(opts[sel]); }
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
        </div>
      )}
      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1 max-h-64 overflow-y-auto rounded-lg border border-line bg-white py-1 shadow-lg">
          {opts.length === 0 && <div className="px-3 py-2 text-sm text-muted">No matches</div>}
          {opts.map((o, i) => (
            <button
              key={o.id}
              type="button"
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(o)}
              className={cx("block w-full px-3 py-1.5 text-left text-sm", i === sel && "bg-gray-50")}
            >
              {o.label} {o.sub && <span className="text-xs text-muted">· {o.sub}</span>}
            </button>
          ))}
          {footer && <div className="border-t border-line px-1 pt-1">{footer(q, () => setOpen(false))}</div>}
        </div>
      )}
    </div>
  );
}

export type CustomerOpt = Opt & { raw: { id: string; full_name: string; mobile: string; family_id: string | null; code: string } };

export function CustomerPicker(props: { value: Opt | null; onChange: (o: CustomerOpt | null) => void; footer?: (q: string, close: () => void) => ReactNode; autoFocus?: boolean; disabled?: boolean }) {
  return (
    <Combo
      {...props}
      onChange={(o) => props.onChange(o as CustomerOpt | null)}
      placeholder="Search name, mobile or code"
      search={async (q) => (await searchCustomers(q)).map((c) => ({ id: c.id, label: c.full_name, sub: `${c.code} · ${prettyPhone(c.mobile)}`, raw: c }))}
    />
  );
}

export function CasePicker(props: { value: Opt | null; onChange: (o: Opt | null) => void; footer?: (q: string, close: () => void) => ReactNode; disabled?: boolean }) {
  return (
    <Combo
      {...props}
      placeholder="Search MAX ID or title"
      search={async (q) => (await searchCases(q)).map((c) => ({ id: c.id, label: c.max_id, sub: `${c.title}${c.customer ? " · " + c.customer.full_name : ""}`, raw: c }))}
    />
  );
}

export type SupplierOpt = Opt & { raw: { id: string; name: string; default_commission: number } };
export function SupplierPicker(props: { value: Opt | null; onChange: (o: SupplierOpt | null) => void; service?: string; footer?: (q: string, close: () => void) => ReactNode }) {
  return (
    <Combo
      {...props}
      onChange={(o) => props.onChange(o as SupplierOpt | null)}
      placeholder="Search supplier"
      search={async (q) => (await searchSuppliers(q, props.service)).map((s) => ({ id: s.id, label: s.name, raw: s }))}
    />
  );
}

export function StaffSelect({ value, onChange, staff, disabled, allowEmpty }: { value: string; onChange: (v: string) => void; staff: { id: string; full_name: string; role: string }[]; disabled?: boolean; allowEmpty?: boolean }) {
  return (
    <select className="field" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {allowEmpty && <option value="">Unassigned</option>}
      {staff.map((s) => <option key={s.id} value={s.id}>{s.full_name}{s.role === "boss" ? " (boss)" : ""}</option>)}
    </select>
  );
}
