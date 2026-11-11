// Acceptance 4 and 6 at the parsing level: multi-passenger return / multi-city structures keep passenger–ticket–segment
// relationships, a document-level fare stays one amount, and missing values block confirmation without being invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockingIssues, reviewIssues, splitIssuedName, toDraft, tripType, validateProviderOutput, type ProviderOutput } from "../../src/lib/imports/schema.ts";

const seg = (ref: number, from: string, to: string, d: string, ad: string, fno: string) => ({
  ref, from, to, dep_date: d, dep_time: "09:05", arr_date: ad, arr_time: "11:40", airline: "Air India", flight_no: fno, cabin: "Economy", baggage: "25K", fare_basis: "", page: 1, evidence: `${from} ${to} ${fno}`,
});
// synthetic sample (no real person or booking)
const returnTrip: ProviderOutput = {
  document_kind: "e_ticket", issue_date: "2026-11-01",
  passengers: [
    { name_as_issued: "TESTER/ASHA MRS", pax_type: "ADT", page: 1, evidence: "TESTER/ASHA MRS", tickets: [{ number: "0981234567890", segment_refs: [1, 2], page: 1 }] },
    { name_as_issued: "TESTER/RAVI MSTR", pax_type: "CHD", page: 1, evidence: "TESTER/RAVI MSTR", tickets: [{ number: "098-1234567891", segment_refs: [], page: 1 }] },
  ],
  airline_pnrs: [{ value: "abc123", airline: "Air India", page: 1 }],
  supplier_refs: [{ value: "GDS-7788", kind: "GDS", page: 1 }],
  segments: [seg(1, "BOM", "DXB", "2026-12-20", "2026-12-20", "AI 983"), seg(2, "DXB", "BOM", "2026-12-28", "2026-12-28", "AI 984")],
  amounts: [{ label: "Total fare", amount: "54,320.00", currency: "INR", scope: "document", passenger_index: 0, page: 1, evidence: "TOTAL INR 54,320.00" }],
  uncertain: [{ path: "segments[1].arr_date", reason: "partly cut off" }],
  notes: "",
};

test("provider output shape is checked by hand", () => {
  assert.equal(validateProviderOutput(returnTrip).ok, true);
  assert.equal(validateProviderOutput({ ...returnTrip, segments: "x" }).ok, false);
  assert.equal(validateProviderOutput({ ...returnTrip, passengers: [{ name_as_issued: 1 }] }).ok, false);
});

test("return trip with two passengers keeps every relationship and one document fare", () => {
  const d = toDraft(returnTrip);
  assert.equal(tripType(d), "return");
  assert.equal(d.passengers.length, 2);
  assert.equal(d.passengers[0].tickets[0].number.value, "098-1234567890");     // identifiers stay strings, leading zero kept
  assert.deepEqual(d.passengers[0].tickets[0].segments, ["s1", "s2"]);
  assert.deepEqual(d.passengers[1].tickets[0].segments, ["s1", "s2"]);         // no refs on the document → covers all legs
  assert.equal(d.passengers[0].name_as_issued.value, "TESTER/ASHA MRS");       // issued name exactly as printed
  assert.equal(d.amounts.length, 1);                                           // not multiplied per passenger
  assert.equal(d.amounts[0].scope, "document");
  assert.equal(d.amounts[0].amount.value, "54,320.00");                        // evidence as printed
  assert.equal(d.airline_pnrs[0].value, "ABC123");
  assert.equal(d.supplier_refs[0].value, "GDS-7788");                          // kept apart from the airline PNR
  assert.equal(d.segments[1].arr_date.flag, "uncertain");
  assert.equal(blockingIssues(d).length, 0);
});

test("multi-city with per-ticket legs", () => {
  const p: ProviderOutput = {
    ...returnTrip,
    passengers: [{ ...returnTrip.passengers[0], tickets: [{ number: "0981234567890", segment_refs: [1, 2], page: 1 }, { number: "0981234567892", segment_refs: [3], page: 2 }] }],
    segments: [seg(1, "DEL", "DXB", "2026-12-20", "2026-12-20", "AI 915"), seg(2, "DXB", "IST", "2026-12-22", "2026-12-22", "TK 761"), seg(3, "IST", "DEL", "2026-12-30", "2026-12-31", "TK 716")],
  };
  const d = toDraft(p);
  assert.equal(tripType(d), "multi-city");
  assert.deepEqual(d.passengers[0].tickets.map((t) => t.segments), [["s1", "s2"], ["s3"]]);
});

test("missing and ambiguous values are flagged, never filled in", () => {
  const p: ProviderOutput = { ...returnTrip, segments: [{ ...seg(1, "BOM", "", "20/12", "", "AI 983") }], uncertain: [] };
  const d = toDraft(p);
  assert.equal(d.segments[0].dep_date.value, "");                              // "20/12" has no year: not guessed
  assert.equal(d.segments[0].dep_date.original, "20/12");
  const block = blockingIssues(d).map((b) => b.path);
  assert.ok(block.includes("segments.0.to"));
  assert.ok(block.includes("segments.0.dep_date"));
  assert.ok(reviewIssues(d).some((i) => i.path === "segments.0.arr_date" && !i.blocking));
});

test("the same ticket number on two passengers is a contradiction", () => {
  const p: ProviderOutput = { ...returnTrip, passengers: returnTrip.passengers.map((x) => ({ ...x, tickets: [{ number: "0981234567890", segment_refs: [], page: 1 }] })) };
  assert.ok(blockingIssues(toDraft(p)).some((i) => /also on/.test(i.text)));
});

test("issued names split only for pre-filling a new person", () => {
  assert.deepEqual(splitIssuedName("TESTER/ASHA MRS"), { last: "Tester", first: "Asha", title: "Mrs" });
  assert.deepEqual(splitIssuedName("Ravi Tester"), { first: "Ravi", last: "Tester", title: "" });
});

test("a flight number printed apart from its airline code is joined (seen on the gateway test)", () => {
  const p: ProviderOutput = { ...returnTrip, segments: [{ ...seg(1, "BOM", "DXB", "2026-12-20", "2026-12-21", "101"), airline: "TA" }] };
  assert.equal(toDraft(p).segments[0].flight_no.value, "TA 101");
  // a full airline name is left alone
  const q: ProviderOutput = { ...returnTrip, segments: [{ ...seg(1, "BOM", "DXB", "2026-12-20", "2026-12-21", "101"), airline: "Test Air" }] };
  assert.equal(toDraft(q).segments[0].flight_no.value, "101");
});

test("passenger types written as words become codes", () => {
  const p: ProviderOutput = { ...returnTrip, passengers: [{ ...returnTrip.passengers[0], pax_type: "adult" }, { ...returnTrip.passengers[1], pax_type: "Child" }] };
  assert.deepEqual(toDraft(p).passengers.map((x) => x.pax_type.value), ["ADT", "CHD"]);
});

// Patterns seen on a low-cost domestic ticket (synthetic values): hyphenated flight number, PNR read as a ticket, leading title.
test("a hyphenated flight number like 6E-1234 is normal", () => {
  const p: ProviderOutput = { ...returnTrip, segments: [{ ...seg(1, "DEL", "HYD", "2026-11-10", "2026-11-10", "6E-1234"), airline: "IndiGo" }] };
  const d = toDraft(p);
  assert.equal(d.segments[0].flight_no.value, "6E 1234");
  assert.ok(!reviewIssues(d).some((i) => i.path === "segments.0.flight_no"));
});

test("a PNR read as a ticket number blocks confirmation", () => {
  const p: ProviderOutput = { ...returnTrip, passengers: [{ ...returnTrip.passengers[0], tickets: [{ number: "TST1230", segment_refs: [], page: 1 }] }] };
  assert.ok(blockingIssues(toDraft(p)).some((i) => /not a ticket number/.test(i.text)));
});

test("a leading title is not taken as the first name", () => {
  assert.deepEqual(splitIssuedName("Mr ASHA TESTER"), { first: "Asha", last: "Tester", title: "Mr" });
});
