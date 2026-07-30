import { describe, expect, test } from "vitest";
import { expensesToCsv } from "../src/csv.js";
import type { Expense } from "../src/db.js";

function exp(over: Partial<Expense>): Expense {
  return {
    id: 1,
    date: "2026-07-18",
    amount_cents: 1250,
    category: "dining",
    description: "coffee",
    source: "chat",
    created_ts: "2026-07-18T10:00:00",
    ...over,
  };
}

describe("expensesToCsv", () => {
  test("header, euro amounts, CRLF line endings", () => {
    const csv = expensesToCsv([exp({})]);
    expect(csv).toBe("date,amount_eur,category,description,source\r\n2026-07-18,12.50,dining,coffee,chat\r\n");
  });

  test("quotes fields containing commas, quotes and newlines", () => {
    const csv = expensesToCsv([exp({ description: 'bread, cheese and "stuff"\nline2' })]);
    expect(csv).toContain('"bread, cheese and ""stuff""\nline2"');
  });

  test("empty list is just the header", () => {
    expect(expensesToCsv([])).toBe("date,amount_eur,category,description,source\r\n");
  });
});
