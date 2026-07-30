import { describe, expect, test } from "vitest";
import { fmtEur, parseAmountToCents } from "../src/money.js";

describe("parseAmountToCents", () => {
  test("plain integers and decimals", () => {
    expect(parseAmountToCents("12")).toBe(1200);
    expect(parseAmountToCents("12.5")).toBe(1250);
    expect(parseAmountToCents("12.50")).toBe(1250);
    expect(parseAmountToCents("0.99")).toBe(99);
  });

  test("french decimal comma", () => {
    expect(parseAmountToCents("12,50")).toBe(1250);
    expect(parseAmountToCents("1 234,56")).toBe(123456);
  });

  test("euro sign and spaces tolerated", () => {
    expect(parseAmountToCents("€12.50")).toBe(1250);
    expect(parseAmountToCents("12.50€")).toBe(1250);
    expect(parseAmountToCents(" 12.50 ")).toBe(1250);
  });

  test("thousands separators", () => {
    expect(parseAmountToCents("1,234.56")).toBe(123456);
    expect(parseAmountToCents("1 234.56")).toBe(123456);
  });

  test("garbage, zero and negatives rejected", () => {
    expect(parseAmountToCents("")).toBeNull();
    expect(parseAmountToCents("abc")).toBeNull();
    expect(parseAmountToCents("12.345")).toBeNull();
    expect(parseAmountToCents("0")).toBeNull();
    expect(parseAmountToCents("-5")).toBeNull();
    expect(parseAmountToCents("12.50.30")).toBeNull();
  });
});

describe("fmtEur", () => {
  test("formats cents with two decimals", () => {
    expect(fmtEur(1250)).toBe("12.50 €");
    expect(fmtEur(99)).toBe("0.99 €");
    expect(fmtEur(120000)).toBe("1200.00 €");
    expect(fmtEur(5)).toBe("0.05 €");
  });

  test("negative amounts keep the sign", () => {
    expect(fmtEur(-1250)).toBe("-12.50 €");
  });
});
