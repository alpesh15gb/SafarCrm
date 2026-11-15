import { test } from "node:test";
import assert from "node:assert/strict";
import { clientDueTiming, reportParams, reportUses } from "../../src/lib/report-filters.ts";

test("report query and export retain exactly the active booking filters", () => {
  const input = { r: "pnl", range: "custom", from: "2026-11-01", to: "2026-11-30", supplier: "supplier-1", customer: "customer-1", cname: "Example customer", staff: "staff-1", service: "flight", months: "3", export: "report" };
  const expected = { r: "pnl", range: "custom", from: "2026-11-01", to: "2026-11-30", supplier: "supplier-1", customer: "customer-1", cname: "Example customer", staff: "staff-1", service: "flight" };
  assert.deepEqual(reportParams("pnl", input), expected);
  const exportParams = Object.fromEntries(new URLSearchParams({ ...input, export: "report" }));
  assert.deepEqual(reportParams("pnl", exportParams), expected);
});

test("changing report tabs clears prior filters, and hidden filters never affect queries", () => {
  assert.deepEqual(reportParams("sales", { r: "sales" }), { r: "sales" });
  assert.deepEqual(reportParams("client_dues", { supplier: "supplier-1", customer: "customer-1", cname: "Example", staff: "staff-1", range: "custom", from: "2026-12-31", to: "2026-11-01" }), {
    r: "client_dues", customer: "customer-1", cname: "Example", staff: "staff-1",
  });
  assert.deepEqual(reportParams("supplier_dues", { supplier: "supplier-1", customer: "customer-1", cname: "Example" }), { r: "supplier_dues", supplier: "supplier-1" });
  assert.equal(reportUses("expiry").customer, false);
  assert.equal(reportUses("supplier_dues").supplier, true);
});

test("calendar presets discard stale custom dates and removed customers discard their labels", () => {
  assert.deepEqual(reportParams("upcoming", { range: "last_month", from: "2026-12-31", to: "2026-11-01", cname: "Former customer" }), { r: "upcoming", range: "last_month" });
  assert.deepEqual(reportParams("expiry", { months: "3", customer: "customer-1" }), { r: "expiry", months: "3" });
});

test("client dues distinguishes future, today and overdue without negative day labels", () => {
  assert.equal(clientDueTiming(-20), "Due in 20 days");
  assert.equal(clientDueTiming(-1), "Due in 1 day");
  assert.equal(clientDueTiming(0), "Due today");
  assert.equal(clientDueTiming(1), "1 day overdue");
  assert.equal(clientDueTiming("20"), "20 days overdue");
  assert.equal(clientDueTiming(null), "");
});
