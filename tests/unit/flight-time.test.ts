// Acceptance 5: same-day timezone crossings, overnight, +2-day and date-line journeys show explicit, correct arrival dates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dayOffset, durationMinutes, offsetLabel, sectorTimeIssues } from "../../src/lib/flight-time.ts";
import { lineProblem } from "../../src/lib/validate.ts";

test("same day across time zones (Dubai → Mumbai)", () => {
  const s = { date: "2026-12-01", dep: "03:00", dep_tz: "Asia/Dubai", arr_date: "2026-12-01", arr: "07:45", arr_tz: "Asia/Kolkata" };
  assert.equal(offsetLabel(s), "");
  assert.equal(durationMinutes(s), 195);
  assert.deepEqual(sectorTimeIssues(s), []);
});

test("overnight (Mumbai 23:30 → Dubai 01:15 next day)", () => {
  const s = { date: "2026-12-01", dep: "23:30", dep_tz: "Asia/Kolkata", arr_date: "2026-12-02", arr: "01:15", arr_tz: "Asia/Dubai" };
  assert.equal(offsetLabel(s), "+1");
  assert.equal(durationMinutes(s), 195);
  assert.deepEqual(sectorTimeIssues(s), []);
});

test("+2 days (San Francisco → Singapore)", () => {
  const s = { date: "2026-12-01", dep: "23:00", dep_tz: "America/Los_Angeles", arr_date: "2026-12-03", arr: "07:00", arr_tz: "Asia/Singapore" };
  assert.equal(offsetLabel(s), "+2");
  assert.equal(durationMinutes(s), 16 * 60);
  assert.deepEqual(sectorTimeIssues(s), []);
});

test("date line westbound (Tokyo → Honolulu lands the day before)", () => {
  const s = { date: "2026-12-03", dep: "00:30", dep_tz: "Asia/Tokyo", arr_date: "2026-12-02", arr: "13:00", arr_tz: "Pacific/Honolulu" };
  assert.equal(dayOffset(s.date, s.arr_date), -1);
  assert.equal(offsetLabel(s), "−1");
  assert.equal(durationMinutes(s), 450);
  assert.deepEqual(sectorTimeIssues(s), []);
});

test("no arrival date: nothing is inferred from the times", () => {
  const s = { date: "2026-12-01", dep: "23:30", arr: "01:15" };
  assert.equal(offsetLabel(s), null);
  const issues = sectorTimeIssues(s);
  assert.ok(issues.some((i) => /arrival date not recorded/.test(i.text)));
});

test("contradictions are reported", () => {
  // lands before take-off once zones are applied
  const back = { date: "2026-12-01", dep: "10:00", dep_tz: "Asia/Kolkata", arr_date: "2026-12-01", arr: "08:00", arr_tz: "Asia/Kolkata" };
  assert.ok(sectorTimeIssues(back).some((i) => i.tone === "red"));
  // four days later is not a flight
  assert.ok(sectorTimeIssues({ date: "2026-12-01", arr_date: "2026-12-05" }).some((i) => i.tone === "red"));
});

test("booking validation refuses an arrival before or at departure", () => {
  for (const arr of ["09:00", "10:00"]) {
    const sector = { from: "HYD", to: "BOM", date: "2026-11-21", dep: "10:00", dep_tz: "Asia/Kolkata", arr_date: "2026-11-21", arr, arr_tz: "Asia/Kolkata" };
    assert.match(lineProblem("flight", { sectors: [sector] }) ?? "", /arrival must be after departure/i);
  }
});

test("booking validation preserves real timezone crossings and incomplete legacy arrivals", () => {
  const sectors = [
    { from: "DEL", to: "DXB", date: "2026-11-21", dep: "10:00", dep_tz: "Asia/Kolkata", arr_date: "2026-11-21", arr: "09:30", arr_tz: "Asia/Dubai" },
    { from: "BOM", to: "DXB", date: "2026-11-21", dep: "23:30", dep_tz: "Asia/Kolkata", arr_date: "2026-11-22", arr: "01:15", arr_tz: "Asia/Dubai" },
    { from: "NRT", to: "HNL", date: "2026-11-21", dep: "00:30", dep_tz: "Asia/Tokyo", arr_date: "2026-11-20", arr: "13:00", arr_tz: "Pacific/Honolulu" },
    { from: "BOM", to: "DXB", date: "2026-11-21", dep: "23:30", arr: "01:15" },
    { from: "AAA", to: "BBB", date: "2026-11-21", dep: "10:00", arr_date: "2026-11-21", arr: "09:00" },
  ];
  for (const sector of sectors) assert.equal(lineProblem("flight", { sectors: [sector] }), null, JSON.stringify(sector));
});

test("booking validation rejects malformed dates and times", () => {
  const sector = { from: "HYD", to: "BOM", date: "2026-11-21", dep: "10:00", dep_tz: "Asia/Kolkata", arr_date: "2026-11-21", arr: "12:00", arr_tz: "Asia/Kolkata" };
  assert.match(lineProblem("flight", { sectors: [{ ...sector, arr_date: "2026-02-30" }] }) ?? "", /not a valid date/);
  assert.match(lineProblem("flight", { sectors: [{ ...sector, arr: "25:00" }] }) ?? "", /arrival time/);
});
