import { test } from "node:test";
import assert from "node:assert/strict";
import { caseOverview } from "../../src/lib/case-overview.ts";

test("running cases are counted per box; a flight + visa case is in both, cancelled bookings are ignored", () => {
  const o = caseOverview(["a", "b", "c", "d", "e"], [
    { case_id: "a", service: "flight", status: "confirmed" },
    { case_id: "a", service: "visa", status: "pending", visa_status: "Applied" },
    { case_id: "b", service: "flight", status: "pending" },
    { case_id: "b", service: "flight", status: "confirmed" },
    { case_id: "c", service: "hotel", status: "confirmed" },
    { case_id: "c", service: "insurance", status: "pending" },
    { case_id: "d", service: "flight", status: "cancelled" },
    { case_id: "z", service: "flight", status: "confirmed" }, // not an active case
  ], { flyingThisWeek: ["a", "z"], checkinDue: ["b", "z"] });
  assert.equal(o.active, 5);
  assert.deepEqual(o.flight, { cases: 2, ticketed: 1, waiting: 1, thisWeek: 1, checkinDue: 1 });
  assert.deepEqual(o.visa, { cases: 1, notSubmitted: 0, submitted: 1, approved: 0, refused: 0 });
  assert.equal(o.other.cases, 1);
  assert.deepEqual(o.other.byService, [{ service: "hotel", cases: 1 }, { service: "insurance", cases: 1 }]);
  assert.equal(o.noBooking.cases, 2, "d (only a cancelled booking) and e (nothing) have no booking yet");
  // each number opens exactly its cases
  assert.deepEqual(o.ids["flight.ticketed"], ["a"]);
  assert.deepEqual(o.ids["flight.pending"], ["b"]);
  assert.deepEqual(o.ids["flight.checkin"], ["b"]);
  assert.deepEqual(o.ids["visa.submitted"], ["a"]);
  assert.deepEqual(o.ids["other.hotel"], ["c"]);
  assert.deepEqual(o.ids.none, ["d", "e"]);
});

test("cases with no booking yet: travelling soon first, then waiting over a week, else new", () => {
  const o = caseOverview(["s", "w", "n", "far"], [], { today: "2026-11-20", cases: [
    { id: "s", created_at: "2026-11-01T10:00:00Z", travel_start: "2026-11-25" },   // old too, but travel soon wins
    { id: "w", created_at: "2026-11-10T10:00:00Z", travel_start: null },
    { id: "n", created_at: "2026-11-19T10:00:00Z", travel_start: "2026-12-20" },
    { id: "far", created_at: "2026-11-18T10:00:00Z", travel_start: "2026-11-28" },
  ] });
  assert.deepEqual(o.noBooking, { cases: 4, travelSoon: 1, waitingLong: 1, fresh: 2 });
});

test("a visa case is as far as its least advanced application", () => {
  const o = caseOverview(["a", "b", "c"], [
    { case_id: "a", service: "visa", status: "pending", visa_status: "Approved" },
    { case_id: "a", service: "visa", status: "pending", visa_status: "Documents pending" },
    { case_id: "b", service: "visa", status: "pending", visa_status: "Approved" },
    { case_id: "c", service: "visa", status: "pending", visa_status: "Rejected" },
  ]);
  assert.deepEqual(o.visa, { cases: 3, notSubmitted: 1, submitted: 0, approved: 1, refused: 1 });
});
