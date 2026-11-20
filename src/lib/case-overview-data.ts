import "server-only";
import { createClient } from "./supabase/server";
import { todayIST } from "./format";
import { caseOverview, type OverviewCase, type OverviewLine } from "./case-overview";

/** Loads the dashboard's Running cases figures. The case list calls the same loader for ?box=…, so a number on the
 *  dashboard and the list it opens are always the same cases. Reads through row-level security: staff see theirs. */
export async function loadCaseOverview(activeIds?: string[]) {
  const sb = await createClient();
  if (!activeIds) {
    const { data } = await sb.rpc("dashboard_case_ids");
    activeIds = ((data ?? []) as { case_id: string }[]).map((r) => r.case_id);
  }
  // ids go in small batches to keep each request short
  const chunks = Array.from({ length: Math.ceil(activeIds.length / 150) }, (_, i) => activeIds!.slice(i * 150, i * 150 + 150));
  const [lines, cases, { data: checkins }, { data: deps }] = await Promise.all([
    Promise.all(chunks.map((ids) => sb.from("booking_lines").select("case_id, service, status, visa_status:details->>application_status").in("case_id", ids))),
    Promise.all(chunks.map((ids) => sb.from("cases").select("id, created_at, travel_start").in("id", ids))),
    // web check-in alerts whose window has opened and that nobody has ticked off yet
    sb.from("tasks").select("case_id").like("auto_key", "webcheckin:%").neq("status", "done").lte("due_at", new Date().toISOString()).limit(500),
    sb.rpc("departures", { p_from: todayIST(), p_to: todayIST(7) }),
  ]);
  return caseOverview(activeIds, lines.flatMap((b) => (b.data ?? []) as OverviewLine[]), {
    flyingThisWeek: ((deps ?? []) as { case_id: string; service: string }[]).filter((d) => d.service === "flight").map((d) => d.case_id),
    checkinDue: (checkins ?? []).map((t) => t.case_id as string),
    cases: cases.flatMap((b) => (b.data ?? []) as OverviewCase[]),
  });
}
