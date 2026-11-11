"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  LayoutDashboard, Briefcase, CheckSquare, Users, Truck, BarChart3, Settings, Search, Plus, Bell, Menu as MenuIcon,
  ChevronsLeft, ChevronsRight, LogOut, UserCircle, X, CornerDownLeft, FileText, Building2, Ticket, type LucideIcon,
} from "lucide-react";
import { cx, Button, Avatar } from "@/components/ui";
import { Menu } from "@/components/client";
import { searchAll, type SearchHit } from "@/actions/search";
import { supabaseBrowser } from "@/lib/supabase/browser";
import { fdatetime } from "@/lib/format";
import type { Me } from "@/lib/auth";
import { NewCaseDialog } from "@/components/forms/new-case";
import { TaskDialog } from "@/components/forms/task-dialog";
import { CustomerQuickDialog } from "@/components/forms/customer-quick";
import { SupplierQuickDialog } from "@/components/forms/supplier-quick";

export type StaffLite = { id: string; full_name: string; role: string };
export type NavCounts = { cases: number; tasks: number; overdue: number };
export type NextCase = { id: string; max_id: string; title: string };
type Ctx = {
  me: Me; staff: StaffLite[]; openNew: (k: NewKind, preset?: Record<string, unknown>) => void;
  /** a case was just left with no open task: ask what happens next */
  askNext: (c: NextCase | null) => void;
};
type NewKind = "case" | "task" | "customer" | "supplier";
const AppCtx = createContext<Ctx | null>(null);
export const useApp = () => useContext(AppCtx)!;

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/cases", label: "Cases", icon: Briefcase, count: "cases" as const },
  { href: "/tasks", label: "Tasks", icon: CheckSquare, count: "tasks" as const },
  { href: "/imports", label: "Ticket imports", icon: Ticket },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/suppliers", label: "Suppliers", icon: Truck },
  { href: "/reports", label: "Reports", icon: BarChart3 },
  { href: "/settings", label: "Settings", icon: Settings, boss: true },
];

/** True on macOS/iOS so shortcut hints read ⌘ instead of Ctrl. */
export function useIsMac() {
  return useSyncExternalStore(
    () => () => {},
    () => /Mac|iPhone|iPad/.test(navigator.userAgent),
    () => true,
  );
}

export function Shell({ me, staff, agency, counts, children }: { me: Me; staff: StaffLite[]; agency: string; counts: NavCounts; children: ReactNode }) {
  const path = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dlg, setDlg] = useState<{ kind: NewKind; preset?: Record<string, unknown> } | null>(null);
  const isMac = useIsMac();

  useEffect(() => {
    try { setCollapsed(localStorage.getItem("nav-collapsed") === "1"); } catch {}
  }, []);
  useEffect(() => setMobileOpen(false), [path]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input,textarea,select,[contenteditable]");
      if ((e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault(); setPaletteOpen(true);
      }
      // ⌘\ / Ctrl+\ toggles the sidebar, like Finder and Notes
      if (e.key === "\\" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggle(); }
    };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  });

  function toggle() {
    const v = !collapsed; setCollapsed(v);
    try { localStorage.setItem("nav-collapsed", v ? "1" : "0"); } catch {}
  }

  const nav = NAV.filter((n) => !n.boss || me.role === "boss");
  const [nextFor, setNextFor] = useState<NextCase | null>(null);
  const ctx: Ctx = { me, staff, openNew: (kind, preset) => setDlg({ kind, preset }), askNext: setNextFor };
  const mini = collapsed && !mobileOpen;

  const sidebar = (
    <nav className="scroll-dark flex h-full flex-col overflow-y-auto bg-navy px-3 pb-3 pt-[max(14px,env(safe-area-inset-top))] text-slate-300">
      <Link href="/dashboard" className={cx("mb-5 flex items-center gap-2.5 rounded-xl px-1.5 py-1", mini && "justify-center")}>
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-linear-to-br from-[#ff9a85] to-coral-dark text-[15px] font-bold text-white shadow-[0_4px_14px_-2px_rgba(250,112,112,0.55)]">{agency[0]}</span>
        {!mini && (
          <span className="min-w-0">
            <span className="block truncate text-[15px] font-semibold tracking-[-0.01em] text-white">{agency}</span>
            <span className="block text-[11px] text-slate-400">Travel CRM</span>
          </span>
        )}
      </Link>
      {!mini && <div className="mb-1.5 px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">Workspace</div>}
      <div className="flex flex-col gap-0.5">
        {nav.map((n) => {
          const active = path === n.href || path.startsWith(n.href + "/");
          const I = n.icon;
          const c = n.count ? counts[n.count] : 0;
          const hot = n.count === "tasks" && counts.overdue > 0;
          return (
            <Link
              key={n.href}
              href={n.href}
              title={n.label}
              className={cx(
                "group relative flex items-center gap-3 rounded-[10px] px-2.5 py-2 text-[13.5px] font-medium transition-colors",
                mini && "justify-center",
                active ? "bg-white/[0.08] text-white" : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-100",
              )}
            >
              {active && <span className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-coral" />}
              <I className={cx("h-[18px] w-[18px] shrink-0", active ? "text-coral" : "text-slate-500 group-hover:text-slate-300")} />
              {!mini && <span className="flex-1">{n.label}</span>}
              {c > 0 && (mini
                ? <span className={cx("absolute right-1.5 top-1.5 h-2 w-2 rounded-full", hot ? "bg-coral" : "bg-slate-500")} />
                : <span className={cx("rounded-full px-1.5 py-px text-[11px] font-semibold tabular", hot ? "bg-coral text-white" : "bg-white/10 text-slate-300")}>{c}</span>)}
            </Link>
          );
        })}
      </div>

      <div className="mt-auto space-y-2 pt-4">
        {!mini && (
          <button type="button" onClick={() => setPaletteOpen(true)} className="flex w-full items-center gap-2 rounded-[10px] border border-white/[0.07] bg-white/[0.03] px-2.5 py-2 text-left text-xs text-slate-400 hover:bg-white/[0.06]">
            <Search className="h-3.5 w-3.5" /><span className="flex-1">Quick find</span>
            <span className="rounded border border-white/10 px-1 text-[10px] text-slate-400">{isMac ? "⌘K" : "Ctrl K"}</span>
          </button>
        )}
        <div className={cx("flex items-center gap-2.5 rounded-xl bg-white/[0.04] p-2", mini && "justify-center bg-transparent p-0")}>
          <Link href="/profile" title="My profile and security"><Avatar name={me.full_name} size="md" className="!ring-navy" /></Link>
          {!mini && (
            <>
              <Link href="/profile" className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-white">{me.full_name}</span>
                <span className="block text-[11px] text-slate-400">{me.role === "boss" ? "Owner · Admin" : "Staff"}</span>
              </Link>
              <LogoutButton icon />
            </>
          )}
        </div>
        <button
          type="button"
          onClick={toggle}
          title={`${collapsed ? "Expand" : "Collapse"} sidebar (${isMac ? "⌘" : "Ctrl"}\\)`}
          className={cx("hidden w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-xs text-slate-500 hover:bg-white/[0.04] hover:text-slate-300 md:flex", mini && "justify-center")}
        >
          {collapsed ? <ChevronsRight className="h-4 w-4" /> : <><ChevronsLeft className="h-4 w-4" /> Collapse</>}
        </button>
      </div>
    </nav>
  );

  return (
    <AppCtx.Provider value={ctx}>
      <div className="flex min-h-dvh">
        <aside className={cx("no-print sticky top-0 hidden h-dvh shrink-0 transition-[width] duration-200 md:block", collapsed ? "w-[72px]" : "w-[244px]")}>{sidebar}</aside>
        {mobileOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            <div className="absolute inset-0 bg-gray-900/40 backdrop-blur-[2px]" onClick={() => setMobileOpen(false)} />
            <aside className="animate-fade-up absolute inset-y-0 left-0 w-72 shadow-xl">
              <button type="button" className="absolute right-2 top-3 z-10 rounded p-1 text-slate-400" onClick={() => setMobileOpen(false)} aria-label="Close menu"><X className="h-5 w-5" /></button>
              {sidebar}
            </aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="no-print sticky top-0 z-40 flex h-[60px] items-center gap-2 border-b border-line bg-white/80 px-3 backdrop-blur-xl backdrop-saturate-150 md:px-6">
            <button type="button" className="rounded p-1.5 text-muted md:hidden" onClick={() => setMobileOpen(true)} aria-label="Menu"><MenuIcon className="h-5 w-5" /></button>
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              className="flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] border border-line bg-gray-50/80 px-3 text-left text-[13.5px] text-gray-400 transition-colors hover:border-gray-300 hover:bg-white md:max-w-lg"
            >
              <Search className="h-4 w-4 shrink-0 text-gray-400" />
              <span className="flex-1 truncate">Search MAX ID, name, phone, PNR, ticket or policy no.</span>
              <span className="kbd max-sm:hidden">{isMac ? "⌘" : "Ctrl"}</span><span className="kbd -ml-1.5 max-sm:hidden">K</span>
            </button>
            <div className="flex-1 max-md:hidden" />
            <Menu trigger={<Button className="max-sm:px-2.5"><Plus className="h-4 w-4 text-coral" /><span className="max-sm:hidden">New</span></Button>}>
              <button type="button" onClick={() => setDlg({ kind: "case" })}>Case (new MAX ID)</button>
              <button type="button" onClick={() => setDlg({ kind: "task" })}>Task or reminder</button>
              <button type="button" onClick={() => setDlg({ kind: "customer" })}>Customer</button>
              <button type="button" onClick={() => setDlg({ kind: "supplier" })}>Supplier</button>
            </Menu>
            <BellButton userId={me.id} />
            <div className="md:hidden">
              <Menu trigger={<button type="button" title={me.full_name}><Avatar name={me.full_name} /></button>}>
                <div className="!cursor-default !bg-white text-xs text-muted">{me.full_name}<br />{me.role === "boss" ? "Boss (admin)" : "Staff"}</div>
                <Link href="/profile"><UserCircle className="mr-2 inline h-4 w-4" />My profile and security</Link>
                <LogoutButton />
              </Menu>
            </div>
          </header>
          <main className="print-full mx-auto w-full max-w-[1440px] flex-1 px-4 pb-[max(20px,env(safe-area-inset-bottom))] pt-6 md:px-8">{children}</main>
        </div>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNew={(kind) => { setPaletteOpen(false); setDlg({ kind }); }} nav={nav} />
      <NewCaseDialog open={dlg?.kind === "case"} onClose={() => setDlg(null)} preset={dlg?.preset} />
      <TaskDialog open={dlg?.kind === "task"} onClose={() => setDlg(null)} preset={dlg?.preset} />
      {nextFor && (
        <div role="status" className="fixed inset-x-3 bottom-3 z-40 mx-auto flex max-w-xl flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900 shadow-lg print:hidden">
          <span className="min-w-0 flex-1"><span className="font-mono font-semibold">{nextFor.max_id}</span> has no next step now. What happens next?</span>
          <Button size="sm" variant="primary" onClick={() => { setDlg({ kind: "task", preset: { case: { id: nextFor.id, label: nextFor.max_id, sub: nextFor.title } } }); setNextFor(null); }}>Add next step</Button>
          <Button size="sm" onClick={() => setNextFor(null)}>Nothing more</Button>
        </div>
      )}
      <CustomerQuickDialog open={dlg?.kind === "customer"} onClose={() => setDlg(null)} />
      <SupplierQuickDialog open={dlg?.kind === "supplier"} onClose={() => setDlg(null)} />
    </AppCtx.Provider>
  );
}

function LogoutButton({ icon }: { icon?: boolean }) {
  const router = useRouter();
  const out = async () => {
    await supabaseBrowser().auth.signOut();
    router.replace("/login");
    router.refresh();
  };
  if (icon) {
    return (
      <button type="button" onClick={out} title="Log out" aria-label="Log out" className="rounded-lg p-1.5 text-slate-500 hover:bg-white/10 hover:text-white">
        <LogOut className="h-4 w-4" />
      </button>
    );
  }
  return (
    <button type="button" onClick={out}>
      <LogOut className="mr-2 inline h-4 w-4" />Log out
    </button>
  );
}

const KIND: Record<string, { label: string; icon: LucideIcon; cls: string }> = {
  case: { label: "Case", icon: Briefcase, cls: "bg-coral-soft text-coral-dark" },
  booking: { label: "Booking", icon: Ticket, cls: "bg-sky-50 text-sky-600" },
  customer: { label: "Customer", icon: Users, cls: "bg-emerald-50 text-emerald-600" },
  supplier: { label: "Supplier", icon: Building2, cls: "bg-violet-50 text-violet-600" },
};

type PItem = { key: string; group: string; label: string; sub?: string; icon: LucideIcon; cls: string; run: () => void };

function CommandPalette({ open, onClose, onNew, nav }: { open: boolean; onClose: () => void; onNew: (k: NewKind) => void; nav: typeof NAV }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const isMac = useIsMac();

  useEffect(() => {
    if (!open) return;
    setQ(""); setHits([]); setSel(0);
    const t = setTimeout(() => input.current?.focus(), 10);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) { setHits([]); return; }
    setLoading(true);
    const h = setTimeout(async () => { setHits(await searchAll(t)); setSel(0); setLoading(false); }, 180);
    return () => clearTimeout(h);
  }, [q]);

  const items: PItem[] = useMemo(() => {
    const go = (href: string) => () => { onClose(); router.push(href); };
    if (q.trim().length >= 2) {
      return hits.map((h, i) => ({ key: h.kind + h.id + i, group: "Results", label: h.label, sub: h.sub, icon: KIND[h.kind]?.icon ?? FileText, cls: KIND[h.kind]?.cls ?? "bg-gray-100", run: go(h.href) }));
    }
    const create: PItem[] = [
      { key: "n-case", group: "Create", label: "New case (MAX ID)", icon: Plus, cls: "bg-coral-soft text-coral-dark", run: () => onNew("case") },
      { key: "n-task", group: "Create", label: "New task or reminder", icon: CheckSquare, cls: "bg-amber-50 text-amber-600", run: () => onNew("task") },
      { key: "n-cust", group: "Create", label: "New customer", icon: Users, cls: "bg-emerald-50 text-emerald-600", run: () => onNew("customer") },
      { key: "n-sup", group: "Create", label: "New supplier", icon: Building2, cls: "bg-violet-50 text-violet-600", run: () => onNew("supplier") },
    ];
    const pages: PItem[] = nav.map((n) => ({ key: "g" + n.href, group: "Go to", label: n.label, icon: n.icon, cls: "bg-gray-100 text-gray-600", run: go(n.href) }));
    return [...create, ...pages, { key: "g-board", group: "Go to", label: "Case board (pipeline)", icon: Briefcase, cls: "bg-gray-100 text-gray-600", run: go("/cases?view=board") }];
  }, [q, hits, nav, onClose, onNew, router]);

  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center px-3 pt-[12vh]" role="dialog" aria-label="Search">
      <div className="absolute inset-0 bg-gray-900/30 backdrop-blur-[3px]" onClick={onClose} />
      <div className="animate-pop relative w-full max-w-[640px] overflow-hidden rounded-2xl border border-black/5 bg-white/95 shadow-pop backdrop-blur-xl">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search className="h-5 w-5 shrink-0 text-gray-400" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              if (e.key === "Enter" && items[sel]) { e.preventDefault(); items[sel].run(); }
              if (e.key === "Escape") { e.preventDefault(); onClose(); }
            }}
            placeholder="Search MAX ID, name, phone, PNR, ticket or policy no."
            className="h-14 flex-1 bg-transparent text-[15px] outline-none placeholder:text-gray-400 focus-visible:outline-none"
          />
          {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-gray-200 border-t-coral" /> : <span className="kbd">esc</span>}
        </div>
        <div ref={list} className="max-h-[min(60vh,440px)] overflow-y-auto p-2">
          {q.trim().length >= 2 && !loading && items.length === 0 && (
            <div className="px-3 py-10 text-center text-sm text-muted">No matches for “{q}”.</div>
          )}
          {items.map((it, i) => {
            const head = i === 0 || items[i - 1].group !== it.group ? it.group : null;
            const I = it.icon;
            return (
              <div key={it.key}>
                {head && <div className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-gray-400">{head}</div>}
                <button
                  type="button"
                  data-i={i}
                  onMouseMove={() => setSel(i)}
                  onClick={it.run}
                  className={cx("flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left", i === sel && "bg-gray-100/80")}
                >
                  <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", it.cls)}><I className="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{it.label}</span>
                    {it.sub && <span className="block truncate text-xs text-muted">{it.sub}</span>}
                  </span>
                  {i === sel && <CornerDownLeft className="h-4 w-4 text-gray-400" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 border-t border-line bg-gray-50/80 px-4 py-2 text-[11px] text-muted">
          <span className="flex items-center gap-1"><span className="kbd">↑</span><span className="kbd">↓</span> move</span>
          <span className="flex items-center gap-1"><span className="kbd">↵</span> open</span>
          <span className="ml-auto flex items-center gap-1"><span className="kbd">{isMac ? "⌘" : "Ctrl"}</span><span className="kbd">K</span> anywhere</span>
        </div>
      </div>
    </div>
  );
}

type Notif = { id: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string };

function BellButton({ userId }: { userId: string }) {
  const router = useRouter();
  const [items, setItems] = useState<Notif[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const unread = items.filter((i) => !i.read_at).length;

  useEffect(() => {
    const sb = supabaseBrowser();
    let alive = true;
    sb.from("notifications").select("id, title, body, link, read_at, created_at").order("created_at", { ascending: false }).limit(30)
      .then(({ data }: { data: Notif[] | null }) => alive && setItems(data ?? []));
    const ch = sb
      .channel("bell-" + userId)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, (p: { new: Notif }) => {
        const n = p.new;
        setItems((x) => [n, ...x].slice(0, 30));
        try {
          if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
            const bn = new Notification(n.title, { body: n.body ?? undefined, tag: n.id });
            bn.onclick = () => { window.focus(); if (n.link) router.push(n.link); };
          }
        } catch {}
        router.refresh();
      })
      .subscribe();
    return () => { alive = false; sb.removeChannel(ch); };
  }, [userId, router]);

  useEffect(() => {
    const m = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", m);
    return () => document.removeEventListener("mousedown", m);
  }, []);

  async function markAll() {
    const now = new Date().toISOString();
    await supabaseBrowser().from("notifications").update({ read_at: now }).is("read_at", null);
    setItems((x) => x.map((i) => ({ ...i, read_at: i.read_at ?? now })));
  }
  async function openItem(n: Notif) {
    setOpen(false);
    if (!n.read_at) {
      await supabaseBrowser().from("notifications").update({ read_at: new Date().toISOString() }).eq("id", n.id);
      setItems((x) => x.map((i) => (i.id === n.id ? { ...i, read_at: new Date().toISOString() } : i)));
    }
    if (n.link) router.push(n.link);
  }

  const canAsk = typeof window !== "undefined" && "Notification" in window && Notification.permission === "default";

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="relative flex h-9 w-9 items-center justify-center rounded-[10px] text-gray-500 hover:bg-gray-100 hover:text-ink" aria-label="Notifications">
        <Bell className="h-[19px] w-[19px]" />
        {unread > 0 && <span className="absolute -right-0.5 -top-0.5 ring-2 ring-white flex h-4 min-w-4 items-center justify-center rounded-full bg-coral px-1 text-[10px] font-semibold text-white">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && (
        <div className="animate-pop absolute right-0 z-50 mt-2 w-[min(92vw,380px)] overflow-hidden rounded-2xl border border-line bg-white shadow-pop">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && <button type="button" className="text-xs link" onClick={markAll}>Mark all read</button>}
          </div>
          {canAsk && (
            <button type="button" onClick={() => Notification.requestPermission()} className="block w-full border-b border-line bg-coral-soft px-3 py-2 text-left text-xs text-coral-dark">
              Turn on browser alerts so you don&apos;t miss reminders
            </button>
          )}
          <div className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">You&apos;re all caught up.</p>}
            {items.map((n) => (
              <button key={n.id} type="button" onClick={() => openItem(n)} className="flex w-full gap-2 border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-gray-50">
                <span className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.read_at ? "bg-transparent" : "bg-coral")} />
                <span className="min-w-0">
                  <span className="block text-sm">{n.title}</span>
                  {n.body && <span className="block text-xs text-muted">{n.body}</span>}
                  <span className="block text-[11px] text-muted">{fdatetime(n.created_at)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
