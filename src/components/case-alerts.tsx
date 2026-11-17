"use client";
// Alerts on a case: the automatic reminders (web check-in, payments due, passport or visa expiring, missing details,
// wallet low). They replaced the Tasks page (owner, 2026-11-18): nobody creates them by hand; they appear when
// something needs doing and close by themselves when it's done, or someone ticks them off.
import { useState } from "react";
import { Bell, Check, ChevronDown } from "lucide-react";
import { Button, cx } from "@/components/ui";
import { useAction } from "@/components/client";
import { markAlertDone } from "@/actions/tasks";
import { fdatetime } from "@/lib/format";

export type AlertRow = { id: string; title: string; due_at: string | null; notes: string | null };

const startOfTomorrow = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return d; };

export function CaseAlerts({ alerts }: { alerts: AlertRow[] }) {
  const { run, pending } = useAction();
  const [showLater, setShowLater] = useState(false);
  if (!alerts.length) return null;
  const now = new Date(), tomorrow = startOfTomorrow();
  // due today or earlier = needs doing now; later ones are listed folded so the box stays short
  const now_ = alerts.filter((a) => !a.due_at || new Date(a.due_at) < tomorrow);
  const later = alerts.filter((a) => a.due_at && new Date(a.due_at) >= tomorrow);
  const row = (a: AlertRow) => {
    const late = !!a.due_at && new Date(a.due_at) < now;
    return (
      <li key={a.id} className="flex items-start gap-3 px-4 py-2">
        <span aria-hidden className={cx("mt-1.5 h-2 w-2 shrink-0 rounded-full", late ? "bg-red-500" : a.due_at && new Date(a.due_at) < tomorrow ? "bg-amber-500" : "bg-gray-300")} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{a.title}</div>
          <div className={cx("text-xs text-muted", late && "!text-red-700")}>
            {a.due_at ? (late ? `Due since ${fdatetime(a.due_at)}` : `Due ${fdatetime(a.due_at)}`) : "Now"}
            {a.notes && <span className="block whitespace-pre-line">{a.notes}</span>}
          </div>
        </div>
        <Button size="sm" disabled={pending} onClick={() => run(() => markAlertDone(a.id))}><Check className="h-3.5 w-3.5" />Done</Button>
      </li>
    );
  };
  return (
    <section aria-label="Alerts" className="mb-4 overflow-hidden rounded-xl border border-line bg-white">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-[13px] font-medium">
        <Bell className="h-4 w-4 text-amber-600" />
        {now_.length ? `${now_.length} alert${now_.length === 1 ? "" : "s"} need${now_.length === 1 ? "s" : ""} attention` : "Coming up"}
      </div>
      {now_.length > 0 && <ul className="divide-y divide-line">{now_.map(row)}</ul>}
      {later.length > 0 && (
        now_.length > 0 && !showLater ? (
          <button type="button" className="flex w-full items-center gap-1 border-t border-line px-4 py-2 text-left text-xs text-muted hover:bg-gray-50" onClick={() => setShowLater(true)}>
            <ChevronDown className="h-3.5 w-3.5" />{later.length} coming up later
          </button>
        ) : <ul className={cx("divide-y divide-line", now_.length > 0 && "border-t border-line")}>{later.map(row)}</ul>
      )}
    </section>
  );
}
