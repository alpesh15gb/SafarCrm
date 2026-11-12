"use client";
import { Check } from "lucide-react";
import { cx } from "@/components/ui";
import { STATUS_LABEL } from "@/lib/constants";

/** Sent when a step is clicked. The case header listens and runs the same checks as before (reason to cancel, open items before completing). */
export const STAGE_EVENT = "safar:case-stage";
const FLOW = ["enquiry", "quoted", "confirmed", "booked", "completed"];
const go = (stage: string) => window.dispatchEvent(new CustomEvent(STAGE_EVENT, { detail: stage }));

/** The one place that shows the stage and changes it: click a step to move the case there. */
export function StageSteps({ status }: { status: string }) {
  if (status === "cancelled") {
    return (
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
        <span className="font-medium">This case is cancelled.</span>
        <span className="text-xs">Reopen it as:</span>
        {FLOW.slice(0, 4).map((s) => (
          <button key={s} type="button" onClick={() => go(s)} className="rounded-full border border-red-200 bg-white px-2.5 py-0.5 text-xs font-medium text-ink hover:bg-gray-50">{STATUS_LABEL[s]}</button>
        ))}
      </div>
    );
  }
  const at = FLOW.indexOf(status);
  return (
    <ol aria-label="Stage. Click a step to move the case there." className="no-print mb-4 flex items-center overflow-x-auto rounded-[14px] border border-line bg-white px-3 py-2 shadow-soft">
      {FLOW.map((s, i) => {
        const done = i < at, cur = i === at;
        return (
          <li key={s} className={cx("flex items-center", i < FLOW.length - 1 && "flex-1")}>
            <button type="button" disabled={cur} aria-current={cur ? "step" : undefined} title={cur ? "Current stage" : `Move to ${STATUS_LABEL[s]}`} onClick={() => go(s)}
              className={cx("flex shrink-0 items-center gap-2 rounded-lg px-1.5 py-1", !cur && "hover:bg-gray-100")}>
              <span className={cx("flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold",
                done ? "bg-emerald-500 text-white" : cur ? "bg-coral text-white ring-4 ring-coral/15" : "bg-gray-100 text-gray-400")}>
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className={cx("whitespace-nowrap text-[13px]", cur ? "font-semibold text-ink" : done ? "font-medium text-ink" : "text-muted")}>{STATUS_LABEL[s]}</span>
            </button>
            {i < FLOW.length - 1 && <span className={cx("mx-2 h-0.5 min-w-6 flex-1 rounded-full", i < at ? "bg-emerald-400" : "bg-gray-200")} />}
          </li>
        );
      })}
    </ol>
  );
}
