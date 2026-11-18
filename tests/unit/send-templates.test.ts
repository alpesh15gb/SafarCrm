import { test } from "node:test";
import assert from "node:assert/strict";
import { sendMessage } from "../../src/lib/send-templates.ts";

const agency = { name: "Max Travel", phone: "7095018018", email: "cs@maxtravel.in" };

test("a confirmed flight ticket reads as the owner's confirmation format", () => {
  const m = sendMessage({
    kind: "ticket", customer: "Tour Testkumar Sharma", maxId: "MAX-1001", agency,
    line: { service: "flight", status: "confirmed", service_date: "2026-12-20", reference: null,
      details: { pnr: "TTPNR1", sectors: [{ from: "BOM", to: "DXB", date: "2026-12-20", dep: "04:30", airline: "Emirates", flight_no: "EK501" }] } },
  });
  assert.match(m.whatsapp, /^\*FLIGHT BOOKING CONFIRMATION\*/);
  assert.match(m.whatsapp, /Dear Tour Testkumar Sharma,/);
  assert.match(m.whatsapp, /Your flight booking has been confirmed!/);
  assert.match(m.whatsapp, /✅ \*BOOKING CONFIRMED\*/);
  assert.match(m.whatsapp, /Flight: \*BOM → DXB · 20-12-2026 04:30 · Emirates EK501\*/);
  assert.match(m.whatsapp, /PNR: \*TTPNR1\*/);
  assert.match(m.whatsapp, /📎 Your e-ticket is attached to this message\./);
  assert.match(m.whatsapp, /Thank you for booking with Max Travel\.\nHave a pleasant journey! ✈️/);
  assert.match(m.html, /BOOKING CONFIRMED/);
  assert.match(m.html, /Your e-ticket is attached to this email/);
  assert.equal(m.subject, "Flight booking confirmation · MAX-1001 · Max Travel");
});

test("a hotel voucher, a pending booking and a file with no booking are worded to match", () => {
  const hotel = sendMessage({ kind: "voucher", customer: "A B", maxId: null, agency,
    line: { service: "hotel", status: "confirmed", service_date: null, reference: null, details: { hotel_name: "Sea View", city: "Goa", check_in: "2026-12-01", check_out: "2026-12-03" } } });
  assert.match(hotel.whatsapp, /HOTEL BOOKING CONFIRMATION/);
  assert.match(hotel.whatsapp, /Hotel: \*Sea View, Goa\*/);
  assert.match(hotel.whatsapp, /hotel voucher/);
  const pending = sendMessage({ kind: "ticket", customer: "A B", maxId: null, agency,
    line: { service: "flight", status: "pending", service_date: null, reference: null, details: { sectors: [] } } });
  assert.doesNotMatch(pending.whatsapp, /BOOKING CONFIRMED/);
  const loose = sendMessage({ kind: "document", customer: "A B", maxId: "MAX-1", agency, line: null });
  assert.match(loose.whatsapp, /TRAVEL DOCUMENT/);
  assert.doesNotMatch(loose.whatsapp, /CONFIRMED/);
});

test("names in the email are escaped", () => {
  const m = sendMessage({ kind: "document", customer: "<b>x</b>", maxId: null, agency, line: null });
  assert.doesNotMatch(m.html, /<b>x<\/b>/);
  assert.match(m.html, /&lt;b&gt;x/);
});

test("both say they are automated and not to reply, with where to ask instead", () => {
  const m = sendMessage({ kind: "document", customer: "A B", maxId: null, agency, line: null });
  assert.match(m.whatsapp, /This is an automated message\. Please do not reply to it\. For any help, contact Max Travel: 7095018018 · cs@maxtravel\.in\./);
  assert.match(m.html, /This is an automated email\. Please do not reply to it\./);
});
