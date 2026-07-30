import type { Expense } from "./db.js";

function field(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** RFC-4180 CSV of expenses. Amounts in euros with two decimals. */
export function expensesToCsv(rows: Expense[]): string {
  const lines = ["date,amount_eur,category,description,source"];
  for (const e of rows) {
    lines.push(
      [e.date, (e.amount_cents / 100).toFixed(2), field(e.category), field(e.description), e.source].join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
