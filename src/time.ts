import { DAY_CODES, type DayCode } from "./config.js";

/** Local calendar date as YYYY-MM-DD in the given timezone. */
export function localDate(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
}

/** Local datetime as YYYY-MM-DDTHH:mm:ss — lexicographically ordered. */
export function localTimestamp(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

export function dayCodeOf(dateIso: string): DayCode {
  return DAY_CODES[new Date(`${dateIso}T00:00:00Z`).getUTCDay()];
}

export function addDays(dateIso: string, n: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** ISO week label, e.g. "2026-W30". */
export function isoWeek(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3); // Thursday of this week
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Monday of the ISO week containing dateIso. */
export function isoWeekStart(dateIso: string): string {
  return addDays(dateIso, -((new Date(`${dateIso}T00:00:00Z`).getUTCDay() + 6) % 7));
}

/** "2026-07-19" → "2026-07". */
export function monthOf(dateIso: string): string {
  return dateIso.slice(0, 7);
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function daysInMonth(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function monthEnd(month: string): string {
  return `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
}

/** "2026-01" → "2025-12". */
export function prevMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Whole months from dateIso until deadline (floored at 1 for "due now or past"). */
export function monthsUntil(dateIso: string, deadline: string): number {
  const [y1, m1] = dateIso.split("-").map(Number);
  const [y2, m2] = deadline.split("-").map(Number);
  return Math.max(1, (y2 - y1) * 12 + (m2 - m1));
}
