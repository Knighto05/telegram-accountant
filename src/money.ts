/** All amounts are stored and computed in integer cents. Euros only appear at the edges:
 * user input (parsed here) and LLM output (rounded in applyResponse). */

/**
 * Parse a user-typed amount into cents. Accepts "12", "12.5", "12.50", "12,50",
 * "€12.50", "12.50€", "1 234,56". Returns null for anything else (including <= 0).
 */
export function parseAmountToCents(raw: string): number | null {
  let s = raw.trim().replace(/€/g, "").replace(/\s/g, "");
  if (s === "") return null;
  // French decimal comma — only when it looks like a decimal separator, not a thousands group.
  if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  else s = s.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return cents > 0 ? cents : null;
}

export function fmtEur(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}${euros}.${String(rest).padStart(2, "0")} €`;
}
