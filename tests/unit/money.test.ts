// Run: node --test --experimental-strip-types tests/unit/   (Node 22.6+)
import { test } from "node:test";
import assert from "node:assert/strict";
import { amount, commissionOf, commissionPaise, lineProfit, moneyProblem, parseMoney, strictAmount } from "../../src/lib/money.ts";

test("missing, invalid, zero and positive amounts are told apart", () => {
  assert.deepEqual(parseMoney(""), { kind: "missing" });
  assert.deepEqual(parseMoney(null), { kind: "missing" });
  assert.deepEqual(parseMoney("  "), { kind: "missing" });
  assert.equal(parseMoney("abc").kind, "invalid");
  assert.equal(parseMoney("12a").kind, "invalid");
  assert.equal(parseMoney("1.2.3").kind, "invalid");
  assert.deepEqual(parseMoney("0"), { kind: "value", paise: 0 });
  assert.deepEqual(parseMoney(0), { kind: "value", paise: 0 });
  assert.deepEqual(parseMoney("₹ 1,25,000.50"), { kind: "value", paise: 12500050 });
  assert.deepEqual(parseMoney("Rs. 500"), { kind: "value", paise: 50000 });
  assert.deepEqual(parseMoney(11000), { kind: "value", paise: 1100000 });
});

test("Indian and international grouping preserve payment and refund amounts", () => {
  for (const value of ["1000000.50", "1,000,000.50", "10,00,000.50", "₹ 10,00,000.50", "Rs. 1,000,000.50"]) {
    assert.deepEqual(parseMoney(value), { kind: "value", paise: 100000050 }, value);
    assert.equal(strictAmount(value), 1000000.5, value);
  }
  for (const value of ["-1,00,000.50", "₹ -1,00,000.50", "-₹ 100,000.50", "Rs. -100,000.50"]) {
    assert.deepEqual(parseMoney(value), { kind: "value", paise: -10000050 }, value);
    assert.equal(moneyProblem("Amount", value, { required: true, allowNegative: true }), null, value);
  }
});

test("malformed separators are refused before preview or payment submission", () => {
  for (const value of ["1,00", "12,34", "1,,000", "100,", ",100", "1234,567", "1,234,56,789", "1,000.5,0", "1 00", "12₹500"]) {
    assert.deepEqual(parseMoney(value), { kind: "invalid", raw: value }, value);
    assert.equal(amount(value), 0, value);
    assert.match(moneyProblem("Amount", value, { required: true, allowNegative: true }) ?? "", /not an amount/, value);
    assert.throws(() => strictAmount(value), /invalid_amount/, value);
  }
});

test("decimal rounding is exact (no float drift), half away from zero like Postgres", () => {
  assert.deepEqual(parseMoney("1.005"), { kind: "value", paise: 101 });
  assert.deepEqual(parseMoney("-1.005"), { kind: "value", paise: -101 });
  assert.deepEqual(parseMoney("2.675"), { kind: "value", paise: 268 });
});

test("moneyProblem refuses unreadable text, allows missing unless required", () => {
  assert.match(moneyProblem("Selling price", "12,5O0") ?? "", /not an amount/);
  assert.equal(moneyProblem("Selling price", ""), null);
  assert.match(moneyProblem("Agency charge", "", { required: true }) ?? "", /needed/);
  assert.match(moneyProblem("GST", "-5") ?? "", /negative/);
  assert.equal(moneyProblem("GST", "0"), null);
});

test("commission matches private.line_compute: base fare when given (zero counts), else supplier cost", () => {
  const base = { status: "active", selling_price: "0", supplier_cost: "10000", commission_type: "percent" as const, commission_value: "7" };
  // round(1234.50 * 7 / 100, 2) = 86.42 in Postgres (86.415 rounds away from zero)
  assert.equal(commissionOf({ ...base, base_fare: "1234.50" }), 86.42);
  assert.equal(commissionPaise({ ...base, base_fare: "1234.50" }), 8642);
  assert.equal(commissionOf({ ...base, base_fare: "" }), 700);         // missing → supplier cost
  assert.equal(commissionOf({ ...base, base_fare: null }), 700);
  assert.equal(commissionOf({ ...base, base_fare: "0" }), 0);          // zero → zero (not the supplier cost)
  assert.equal(commissionOf({ ...base, commission_type: "amount", commission_value: "250.5" }), 250.5);
  assert.equal(commissionOf({ ...base, commission_value: "2.5", base_fare: "999.99" }), 25);   // 24.99975 → 25.00
});

test("profit uses paise throughout", () => {
  assert.equal(lineProfit({ status: "active", selling_price: "0.1", supplier_cost: "0.2", commission_type: "amount", commission_value: "0.3" }), 0.2);
  assert.equal(lineProfit({ status: "cancelled", selling_price: "1000", supplier_cost: "800", commission_type: "amount", commission_value: "50", refund_to_client: "600", refund_from_supplier: "500" }), 100);
});
