"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, X } from "lucide-react";
import { Button, cx } from "./ui";
import type { ActionResult } from "@/lib/auth";

// ---------------------------------------------------------------- toasts
type ToastItem = { id: number; text: string; tone: "ok" | "error" };
const ToastCtx = createContext<(text: string, tone?: "ok" | "error") => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function Toaster({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, tone: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), tone === "error" ? 6000 : 2800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="no-print pointer-events-none fixed bottom-4 left-1/2 z-[100] flex w-[min(92vw,380px)] -translate-x-1/2 flex-col gap-2 md:left-auto md:right-4 md:translate-x-0">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={cx(
              "animate-pop pointer-events-auto rounded-xl border px-3.5 py-2.5 text-sm font-medium shadow-pop",
              t.tone === "ok" ? "border-white/10 bg-navy text-white" : "border-red-200 bg-red-50 text-red-700",
            )}
          >
            {t.tone === "ok" && <Check className="mr-1.5 inline h-4 w-4 text-emerald-400" />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Run a server action with a toast and a refresh. */
export function useAction() {
  const toast = useToast();
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = useCallback(
    <T,>(fn: () => Promise<ActionResult<T>>, opts?: { success?: string; then?: (r: ActionResult<T> & { ok: true }) => void; refresh?: boolean }) =>
      new Promise<boolean>((resolve) =>
        start(async () => {
          try {
            const r = await fn();
            if (r.ok) {
              const msg = opts?.success ?? r.message;
              if (msg) toast(msg);
              opts?.then?.(r);
              if (opts?.refresh !== false) router.refresh();
              resolve(true);
            } else {
              toast(r.error, "error");
              resolve(false);
            }
          } catch (e) {
            toast(e instanceof Error ? e.message : "Something went wrong", "error");
            resolve(false);
          }
        }),
      ),
    [toast, router],
  );
  return { run, pending };
}

// ---------------------------------------------------------------- dialog
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      className={cx(
        "m-auto max-h-[92vh] w-[calc(100vw-24px)] rounded-2xl border border-black/5 bg-white p-0 text-ink shadow-pop backdrop:bg-gray-900/35 backdrop:backdrop-blur-[3px] open:animate-pop",
        wide ? "max-w-3xl" : "max-w-lg",
      )}
    >
      {open && (
        <div className="flex max-h-[92vh] flex-col">
          <div className="flex items-center justify-between border-b border-line px-5 py-4">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h2>
            <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-muted hover:bg-gray-100 hover:text-ink" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line bg-gray-50/70 px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function Confirm({ open, onClose, title, text, confirmLabel = "Confirm", onConfirm, pending, children }: {
  open: boolean; onClose: () => void; title: string; text?: string; confirmLabel?: string; onConfirm: () => void; pending?: boolean; children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button onClick={onClose}>Keep</Button>
          <Button variant="primary" className="!border-red-600 !bg-red-600 hover:!bg-red-700" disabled={pending} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {text && <p className="text-muted">{text}</p>}
      {children}
    </Dialog>
  );
}

// ---------------------------------------------------------------- copy
export function CopyButton({ text, label, className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={`Copy ${text}`}
      onClick={async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      className={cx("inline-flex items-center gap-1 rounded px-1 text-muted hover:bg-gray-100 hover:text-ink", className)}
    >
      {label}
      {done ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

export function MaxId({ id, className }: { id: string; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-0.5 font-mono text-[13px] font-semibold", className)}>
      {id}
      <CopyButton text={id} />
    </span>
  );
}

// ---------------------------------------------------------------- menu
export function Menu({ trigger, children, align = "right" }: { trigger: ReactNode; children: ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger}</div>
      {open && (
        <div
          onClick={() => setOpen(false)}
          className={cx(
            "animate-pop absolute z-50 mt-1.5 min-w-52 rounded-xl border border-line bg-white p-1 shadow-pop [&>*]:block [&>*]:w-full [&>*]:rounded-lg [&>*]:px-2.5 [&>*]:py-2 [&>*]:text-left [&>*]:text-[13.5px] [&>*:hover]:bg-gray-100/80",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function More({ title = "More details", children, defaultOpen }: { title?: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group rounded-xl border border-line bg-white">
      <summary className="cursor-pointer select-none list-none px-3 py-2 text-sm font-medium text-muted hover:text-ink">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">›</span> {title}
      </summary>
      <div className="border-t border-line p-3">{children}</div>
    </details>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx("inline-flex cursor-pointer items-center gap-2 text-sm", disabled && "opacity-50")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx("relative h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-coral" : "bg-gray-300")}
      >
        <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", checked ? "left-[18px]" : "left-0.5")} />
      </button>
      {label}
    </label>
  );
}
