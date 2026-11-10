import { fdatetime } from "@/lib/format";
import { Avatar } from "./ui";

type Item = { id: number; actor_name: string | null; action: string; entity: string; summary: string | null; changes: Record<string, { from?: unknown; to?: unknown }> | null; created_at: string };

const VERB: Record<string, string> = {
  insert: "added", update: "changed", delete: "deleted", reveal: "revealed", convert: "converted", link: "linked", relink: "moved",
  override: "completed with open items", confirm: "confirmed", review: "reviewed", reject: "rejected", publish: "published",
};
const ENTITY: Record<string, string> = { case: "case", booking_line: "booking", payment: "payment", expense: "expense", file: "file", customer: "customer", document: "document", supplier: "supplier", task: "task", ticket_import: "ticket import" };
const HIDE = new Set(["details", "client_view", "traveller_ids", "visas", "loyalty", "other_ids"]);

function show(v: unknown) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "object") return Array.isArray(v) ? v.join(", ") || "—" : "…";
  return String(v);
}

export function ActivityList({ items }: { items: Item[] }) {
  if (!items.length) return <p className="text-muted">No activity yet.</p>;
  return (
    <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[13px] before:top-2 before:w-px before:bg-line">
      {items.map((a) => (
        <li key={a.id} className="relative flex gap-3 text-sm">
          <Avatar name={a.actor_name ?? "System"} size="sm" className="mt-0.5 !h-7 !w-7" />
          <div className="min-w-0">
            <div>
              <b className="font-medium">{a.actor_name ?? "System"}</b> {VERB[a.action] ?? a.action} {["reveal", "override"].includes(a.action) ? "" : `the ${ENTITY[a.entity] ?? a.entity}`} <span className="text-muted">{a.summary}</span>
            </div>
            {a.changes && Object.keys(a.changes).length > 0 && (
              <div className="mt-0.5 text-xs text-muted">
                {Object.entries(a.changes).map(([k, v]) => (
                  <span key={k} className="mr-3 inline-block">
                    {k.replace(/_/g, " ")}{HIDE.has(k) ? " updated" : !v || typeof v !== "object" || Array.isArray(v) ? `: ${show(v)}` : `: ${show(v.from)} → ${show(v.to)}`}
                  </span>
                ))}
              </div>
            )}
            <div className="text-[11px] text-muted">{fdatetime(a.created_at)}</div>
          </div>
        </li>
      ))}
    </ol>
  );
}
