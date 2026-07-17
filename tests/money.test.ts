import { describe, expect, test } from "bun:test";
import { Decimal, advanceOn } from "../src/money";

describe("advanceOn (Business Rule 1: 10% advance)", () => {
  test("10% of ₹40 is ₹4.00 — the worked example's per-sale advance", () => {
    expect(advanceOn(new Decimal(40)).toFixed(2)).toBe("4.00");
  });

  test("10% of ₹30 is ₹3.00 — blueprint Case 1 advance", () => {
    expect(advanceOn(new Decimal(30)).toFixed(2)).toBe("3.00");
  });

  test("rounds to 2 decimal places: 10% of ₹33.33 → ₹3.33", () => {
    expect(advanceOn(new Decimal("33.33")).toFixed(2)).toBe("3.33");
  });

  test("rounds half-up on an exact half-paisa: 10% of ₹0.05 → ₹0.01", () => {
    expect(advanceOn(new Decimal("0.05")).toFixed(2)).toBe("0.01");
  });

  test("zero earning yields zero advance", () => {
    expect(advanceOn(new Decimal(0)).isZero()).toBe(true);
  });
});
