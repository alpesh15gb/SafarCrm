// Portal ticket layouts the agency receives (TripJack, Alhind, Cleartrip, Air India NDC, Amadeus portals):
// names with type markers, frequent flyer numbers.
// Synthetic values only (no real person or booking).
import { test } from "node:test";
import assert from "node:assert/strict";
import { genderFromTitle, normFF, splitIssuedName, toDraft, validateProviderOutput, type ProviderOutput } from "../../src/lib/imports/schema.ts";

test("portal-style names: type markers, dotted titles and middle names", () => {
  assert.deepEqual(splitIssuedName("MR ASHA KUMAR TESTER ( A )"), { first: "Asha Kumar", last: "Tester", title: "Mr" });
  assert.deepEqual(splitIssuedName("Ms .RIYA TESTER (ADT)"), { first: "Riya", last: "Tester", title: "Ms" });
  assert.deepEqual(splitIssuedName("Mr. RAVI TESTER"), { first: "Ravi", last: "Tester", title: "Mr" });
  assert.deepEqual(splitIssuedName("Mr Ravi TESTER"), { first: "Ravi", last: "Tester", title: "Mr" });
  assert.equal(genderFromTitle("Ms"), "Female");
  assert.equal(genderFromTitle("Mr"), "Male");
  assert.equal(genderFromTitle("Dr"), "");
});

test("frequent flyer numbers: airline split from the number, label stripped, blanks dropped", () => {
  assert.deepEqual(normFF([{ airline: "", number: "AI 100000001" }]), [{ airline: "AI", number: "100000001" }]);
  assert.deepEqual(normFF([{ airline: "", number: "FF: 200000002" }], "EK 527"), [{ airline: "EK", number: "200000002" }]);
  assert.deepEqual(normFF([{ airline: "Emirates", number: "200 000 002" }]), [{ airline: "Emirates", number: "200000002" }]);
  assert.deepEqual(normFF([{ airline: "", number: "--" }, { airline: "", number: "NA" }]), []);
  assert.deepEqual(normFF([{ airline: "AI", number: "100000001" }, { airline: "AI", number: "100000001" }]), [{ airline: "AI", number: "100000001" }]);
});

const base: ProviderOutput = {
  document_kind: "e_ticket", issue_date: "2026-11-13",
  passengers: [{ name_as_issued: "MR ASHA TESTER", pax_type: "( A )", page: 1, evidence: "MR ASHA TESTER ( A ) FF: 200000002",
    tickets: [{ number: "17600000000001", segment_refs: [1], page: 1 }], frequent_flyer: [{ airline: "", number: "200000002" }] }],
  airline_pnrs: [{ value: "TST123", airline: "Emirates", page: 1 }],
  supplier_refs: [{ value: "TJ1000000000001", kind: "Booking ID", page: 1 }],
  segments: [{ ref: 1, from: "HYD", to: "DXB", dep_date: "2026-11-16", dep_time: "10:00", arr_date: "2026-11-16", arr_time: "12:25", airline: "Emirates", flight_no: "EK - 527", cabin: "Business", baggage: "40 Kilogram", fare_basis: "", page: 1, evidence: "EK - 527 Hyderabad Dubai" }],
  amounts: [], uncertain: [], notes: "",
};

test("frequent flyer numbers reach the draft; '( A )' reads as adult", () => {
  assert.equal(validateProviderOutput(base).ok, true);
  const d = toDraft(base);
  assert.deepEqual(d.passengers[0].ff, [{ airline: "EK", number: "200000002" }]);
  assert.equal(d.passengers[0].pax_type.value, "ADT");
  assert.equal(d.segments[0].flight_no.value, "EK 527");
});

test("an older reply without frequent flyer numbers still reads", () => {
  const old = base;
  const p = { ...old, passengers: [{ ...base.passengers[0], frequent_flyer: undefined }] };
  assert.equal(validateProviderOutput(p).ok, true);
  assert.deepEqual(toDraft(p as ProviderOutput).passengers[0].ff, []);
  assert.equal(validateProviderOutput({ ...base, passengers: [{ ...base.passengers[0], frequent_flyer: [{ airline: 1 }] }] }).ok, false);
});

