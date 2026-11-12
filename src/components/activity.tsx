import { createClient } from "@/lib/supabase/server";
import { fdate, fdatetime, inr } from "@/lib/format";
import { STATUS_LABEL } from "@/lib/constants";
import { Avatar } from "./ui";

type Item = { id: number; actor_name: string | null; action: string; entity: string; summary: string | null; changes: Record<string, { from?: unknown; to?: unknown }> | null; created_at: string };

const VERB: Record<string, string> = {
  insert: "added", update: "changed", delete: "deleted", reveal: "revealed", convert: "converted", link: "linked", relink: "moved",
  override: "completed with open items", confirm: "confirmed", review: "reviewed", reject: "rejected", publish: "published",
  issue: "issued", cancel: "cancelled",
};
const ENTITY: Record<string, string> = { case: "case", booking_line: "booking", payment: "payment", expense: "expense", file: "file", customer: "customer", document: "document", supplier: "supplier", task: "task", ticket_import: "ticket import", invoice: "invoice" };

// shown as "… updated" without the values (long or structured)
const NO_VALUES = new Set(["details", "client_view", "traveller_ids", "visas", "loyalty", "other_ids", "notes", "tags"]);
// bookkeeping the team never needs to read
const SKIP = new Set([
  "pricing_state", "work_state", "work_state_at", "waiting_follow_up_at", "sort", "source_document_id", "import_id", "storage_path", "sha256",
  "auto_key", "created_by", "created_at", "family_id", "search", "id", "case_id", "customer_id", "booking_line_id", "confirm_key", "draft_version",
]);
// plain words for column names (per kind of record where the same column means different things)
const LABEL: Record<string, string> = {
  "case.status": "Stage", status: "Status", assigned_to: "Owner", "task.assigned_to": "Given to", supplier_id: "Supplier", received_by: "Received by",
  travel_start: "Travel start", travel_end: "Travel end", destination: "Destination", title: "Title", lead_source: "Lead source",
  cancel_reason: "Cancel reason", waiting_reason: "Waiting for", is_international: "International trip",
  supplier_cost: "Supplier cost", selling_price: "Selling price", commission_value: "Commission", commission_type: "Commission type", gst: "GST",
  payment_due_date: "Client payment due", supplier_due_date: "Supplier payment due", reference: "Reference", visible_to_client: "Visible to client",
  refund_to_client: "Refund to client", refund_from_supplier: "Refund from supplier", amount: "Amount", pay_date: "Date", mode: "Mode",
  due_at: "Due", priority: "Priority", alert: "Reminder", blocking: "Required", mobile: "Mobile", whatsapp: "WhatsApp", email: "Email",
  passport_expiry: "Passport expiry", dob: "Date of birth", id_numbers: "ID numbers", max_attempts: "Attempts",
};
const MONEY = new Set(["supplier_cost", "selling_price", "gst", "amount", "refund_to_client", "refund_from_supplier"]);
const WORDS: Record<string, string> = { ...STATUS_LABEL, upi: "UPI", bank: "Bank transfer", cash: "Cash", card: "Card", cheque: "Cheque", normal: "Normal", high: "High", low: "Low", none: "No reminder", due: "At due time" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function label(entity: string, k: string) {
  const l = LABEL[`${entity}.${k}`] ?? LABEL[k] ?? k.replace(/_/g, " ");
  return l.charAt(0).toUpperCase() + l.slice(1);
}

function show(k: string, v: unknown, names: Map<string, string>): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "object") return Array.isArray(v) ? v.join(", ") || "—" : "…";
  const s = String(v);
  if (UUID.test(s)) return names.get(s) ?? "someone";
  if (MONEY.has(k) && !Number.isNaN(Number(s))) return inr(s);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return fdatetime(s);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return fdate(s);
  return WORDS[s] ?? s;
}

/** The history of a case, customer or supplier in plain words: names instead of ids, labels instead of column names. */
export async function ActivityList({ items }: { items: Item[] }) {
  if (!items.length) return <p className="text-muted">No activity yet.</p>;

  // ids that appear in the changes are looked up once and shown as names
  const ids = new Set<string>();
  for (const a of items) for (const v of Object.values(a.changes ?? {})) {
    for (const x of v && typeof v === "object" && !Array.isArray(v) ? [v.from, v.to] : [v]) if (typeof x === "string" && UUID.test(x)) ids.add(x);
  }
  const names = new Map<string, string>();
  if (ids.size) {
    const list = Array.from(ids).slice(0, 200);
    const sb = await createClient();
    const [p, s, c] = await Promise.all([
      sb.from("profiles").select("id, full_name").in("id", list),
      sb.from("suppliers").select("id, name").in("id", list),
      sb.from("customers").select("id, full_name").in("id", list),
    ]);
    for (const r of p.data ?? []) names.set(r.id, r.full_name);
    for (const r of s.data ?? []) names.set(r.id, r.name);
    for (const r of c.data ?? []) names.set(r.id, r.full_name);
  }

  return (
    <ol className="relative space-y-4 before:absolute before:bottom-2 before:left-[13px] before:top-2 before:w-px before:bg-line">
      {items.map((a) => {
        const changes = Object.entries(a.changes ?? {}).filter(([k]) => !SKIP.has(k));
        return (
          <li key={a.id} className="relative flex gap-3 text-sm">
            <Avatar name={a.actor_name ?? "System"} size="sm" className="mt-0.5 !h-7 !w-7" />
            <div className="min-w-0">
              <div>
                <b className="font-medium">{a.actor_name ?? "Automatic"}</b> {VERB[a.action] ?? a.action} {["reveal", "override"].includes(a.action) ? "" : `the ${ENTITY[a.entity] ?? a.entity}`} <span className="text-muted">{a.summary}</span>
              </div>
              {changes.length > 0 && (
                <div className="mt-0.5 text-xs text-muted">
                  {changes.map(([k, v]) => (
                    <span key={k} className="mr-3 inline-block">
                      {label(a.entity, k)}{NO_VALUES.has(k) ? " updated"
                        : !v || typeof v !== "object" || Array.isArray(v) ? `: ${show(k, v, names)}`
                        : `: ${show(k, v.from, names)} → ${show(k, v.to, names)}`}
                    </span>
                  ))}
                </div>
              )}
              <div className="text-[11px] text-muted">{fdatetime(a.created_at)}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
