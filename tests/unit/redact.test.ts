// Masking before the model call: identifiers go, booking facts stay. Synthetic values only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactForModel } from "../../src/lib/imports/redact.ts";

test("booking facts are left exactly as printed", () => {
  const doc = [
    "E-TICKET  PNR: ABC123  Ticket No: 098-9876543210  0981234567890  ZYHTQS0",
    "6E-6217 DELHI (DEL) 16:20 10-Nov-2026  HYDERABAD (HYD) 18:40",
    "AI 983 BOM DXB 2026-12-20 09:05  Total INR 54,320.00",
  ].join("\n");
  const r = redactForModel(doc);
  assert.equal(r.text, doc);
  assert.deepEqual(r.counts, {});
});

test("contact details are masked", () => {
  const r = redactForModel("Contact: +91 98765 43210 / 9123456789, tester@example.com");
  assert.equal(r.text, "Contact: [mobile] / [mobile], [email]");
  assert.equal(r.counts.mobile, 2);
  assert.equal(r.counts.email, 1);
});

test("passport numbers next to a label or in a DOCS line are masked", () => {
  const r = redactForModel("Passport No: K1234567\nSSR DOCS AI HK1 P/IND/Z9876543/IND/01JAN90/F/01JAN30/TESTER/ASHA");
  assert.match(r.text, /Passport No: \[passport\]/);
  assert.match(r.text, /P\/IND\/\[passport\]\//);
  assert.equal(r.counts.passport, 2);
});

test("a booking reference that looks like a passport number is left alone without a label", () => {
  assert.equal(redactForModel("Ref K1234567").text, "Ref K1234567");
});

test("date of birth, Aadhaar, PAN and card numbers are masked; flight dates are not", () => {
  const r = redactForModel("DOB: 01/01/1990  Aadhaar 1234 5678 9012  PAN ABCDE1234F  Card 4111 1111 1111 1111  Departs 20/12/2026");
  assert.match(r.text, /DOB: \[date of birth\]/);
  assert.match(r.text, /\[aadhaar\]/);
  assert.match(r.text, /\[pan\]/);
  assert.match(r.text, /\[card ending 1111\]/);
  assert.match(r.text, /Departs 20\/12\/2026/);
});

test("a 16-digit number that fails the card checksum is not taken for a card", () => {
  assert.equal(redactForModel("Order 1234567812345678").text, "Order 1234567812345678");
});
