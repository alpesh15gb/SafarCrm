import { test } from "node:test";
import assert from "node:assert/strict";
import { customRangeError, RangeValidationError, resolveRange } from "../../src/lib/range.ts";
import { monthRange } from "../../src/lib/format.ts";

test("custom report dates reject reversed ranges instead of querying or exporting empty data", () => {
  const params = { range: "custom", from: "2026-12-01", to: "2026-11-01" };
  assert.equal(customRangeError(params.from, params.to), "From must be on or before To.");
  assert.throws(() => resolveRange(params), RangeValidationError);
  assert.equal(customRangeError("2026-11-01", "2026-11-01"), null);
  assert.deepEqual(resolveRange({ range: "custom", from: "2026-11-01", to: "2026-11-01" }), { from: "2026-11-01", to: "2026-11-01", label: "01-11-2026 to 01-11-2026" });
});

test("custom dates reject malformed dates and the form asks for both endpoints", () => {
  assert.equal(customRangeError("2026-11-01", ""), "Choose both From and To dates.");
  assert.throws(() => resolveRange({ range: "custom", from: "2026-02-30", to: "2026-03-01" }), RangeValidationError);
  assert.throws(() => resolveRange({ range: "custom", from: "not-a-date", to: "2026-03-01" }), RangeValidationError);
});

test("This month uses calendar boundaries including upcoming travel's default selection", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-16T10:00:00Z") });
  assert.deepEqual(resolveRange({}), { from: "2026-11-01", to: "2026-11-30", label: "This month" });
  assert.equal(resolveRange({ range: "" }).to, "2026-11-30");
  assert.deepEqual(resolveRange({ range: "last_month" }), { ...monthRange(-1), label: "Last month" });
});
