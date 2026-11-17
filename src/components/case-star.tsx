"use client";
// The boss's star on a case: starred cases stay at the top of the case list for everyone (owner, 2026-11-18).
// The boss can click it; everyone else just sees it.
import { Star } from "lucide-react";
import { cx } from "@/components/ui";
import { useAction } from "@/components/client";
import { setCaseStar } from "@/actions/cases";

export function CaseStar({ id, starred, canStar, size = "sm" }: { id: string; starred: boolean; canStar: boolean; size?: "sm" | "md" }) {
  const { run, pending } = useAction();
  const icon = <Star className={cx(size === "md" ? "h-5 w-5" : "h-4 w-4", starred ? "fill-amber-400 text-amber-500" : "text-gray-300")} />;
  if (!canStar) return starred ? <span title="Starred by the boss" className="inline-flex">{icon}</span> : null;
  return (
    <button type="button" disabled={pending} aria-pressed={starred} title={starred ? "Remove star" : "Star: keep at the top of the list"}
      aria-label={starred ? "Remove star" : "Star this case"}
      className="relative z-10 inline-flex rounded p-0.5 hover:bg-amber-50"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); run(() => setCaseStar(id, !starred)); }}>
      {icon}
    </button>
  );
}
