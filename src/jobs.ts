import { Cron } from "croner";
import type { Config } from "./config.js";
import { DAY_CODES } from "./config.js";
import * as store from "./db.js";
import type { Db } from "./db.js";
import { MSG } from "./messages.js";
import { fmtEur } from "./money.js";
import { periodStatus } from "./handlers.js";
import { addDays, isoWeek, isoWeekStart, localDate, localTimestamp, monthEnd, monthOf, monthStart, monthsUntil, prevMonth } from "./time.js";
import { summarizeConversation, type AccountantDeps } from "./accountant.js";

export interface JobDeps {
  db: Db;
  config: Config;
  send: (text: string) => Promise<void>;
  now: () => Date;
  accountant?: AccountantDeps;
  log: (msg: string) => void;
}

export function isPaused(db: Db, today: string): boolean {
  const until = store.getSetting(db, "paused_until", "");
  return until !== "" && today < until;
}

/**
 * Gate for scheduled sends (recap, weekly, monthly): pause + once-per-period idempotency.
 * No daily cap — the recap is SUPPOSED to fire every day. The sent text is logged into the
 * conversation so the LLM understands the user's answer to "anything not logged?".
 */
export async function sendScheduled(deps: JobDeps, key: string, period: string, text: string): Promise<boolean> {
  const today = localDate(deps.now(), deps.config.timezone);
  if (isPaused(deps.db, today)) return false;
  if (store.getSetting(deps.db, key, "") === period) return false;
  await deps.send(text);
  store.setSetting(deps.db, key, period);
  store.logMessage(deps.db, localTimestamp(deps.now(), deps.config.timezone), "assistant", text);
  return true;
}

/** Gate for extra, unscheduled pings: pause + hard once-per-day cap. Extension point, unused today. */
export async function sendNudge(deps: JobDeps, text: string): Promise<boolean> {
  const today = localDate(deps.now(), deps.config.timezone);
  if (isPaused(deps.db, today)) return false;
  if (store.getSetting(deps.db, "last_nudge_date", "") === today) return false;
  await deps.send(text);
  store.setSetting(deps.db, "last_nudge_date", today);
  return true;
}

/** End-of-day recap: today's numbers, budget lines that moved, and the "anything missing?" question. */
export async function runDailyRecap(deps: JobDeps): Promise<void> {
  const today = localDate(deps.now(), deps.config.timezone);
  const month = monthOf(today);
  const lines: string[] = [];
  const todayTotal = store.totalCentsBetween(deps.db, today, today);
  if (todayTotal === 0) {
    lines.push(MSG.RECAP_NOTHING);
  } else {
    lines.push(periodStatus(deps.db, today, today, `Today ${today}`));
    const todayCats = new Set(store.spentByCategory(deps.db, today, today).map((c) => c.category));
    const moved = store.budgetStatus(deps.db, month).filter((b) => todayCats.has(b.category));
    for (const b of moved) {
      lines.push(
        b.remaining_cents < 0
          ? `${b.category} is over budget by ${fmtEur(-b.remaining_cents)}.`
          : `${b.category}: ${fmtEur(b.remaining_cents)} left this month.`,
      );
    }
  }
  lines.push(MSG.RECAP_ASK);
  if (await sendScheduled(deps, "last_recap_date", today, lines.join("\n"))) {
    deps.log("job: daily recap sent");
  }
  // Piggyback: conversation compaction. Not a user-facing send, so outside any gate.
  await runCompaction(deps);
}

export async function runWeeklyReport(deps: JobDeps): Promise<void> {
  const today = localDate(deps.now(), deps.config.timezone);
  const week = isoWeek(today);
  const start = isoWeekStart(today);
  const end = addDays(start, 6);
  const total = store.totalCentsBetween(deps.db, start, end);
  const prevTotal = store.totalCentsBetween(deps.db, addDays(start, -7), addDays(start, -1));
  const lines = [periodStatus(deps.db, start, end, `Week ${week}`)];
  if (prevTotal > 0 || total > 0) {
    const diff = total - prevTotal;
    lines.push(`Last week: ${fmtEur(prevTotal)} (${diff >= 0 ? "+" : ""}${fmtEur(diff)}).`);
  }
  if (await sendScheduled(deps, "last_weekly_report", week, lines.join("\n"))) {
    deps.log("job: weekly report sent");
  }
}

/** Fires on the 1st: closes out the previous month. */
export async function runMonthlyReport(deps: JobDeps): Promise<void> {
  const today = localDate(deps.now(), deps.config.timezone);
  const month = prevMonth(monthOf(today));
  const start = monthStart(month);
  const end = monthEnd(month);
  const spent = store.totalCentsBetween(deps.db, start, end);
  const income = store.incomeTotalBetween(deps.db, start, end);
  const balance = income - spent;
  const before = prevMonth(month);
  const beforeSpent = store.totalCentsBetween(deps.db, monthStart(before), monthEnd(before));

  const lines = [
    `Month ${month} closed.`,
    `Spent ${fmtEur(spent)}, income ${fmtEur(income)}, balance ${balance >= 0 ? "+" : ""}${fmtEur(balance)}.`,
  ];
  const byCat = store.spentByCategory(deps.db, start, end);
  const budgetMap = new Map(store.budgets(deps.db).map((b) => [b.category, b.monthly_cents]));
  for (const c of byCat.slice(0, 8)) {
    const budget = budgetMap.get(c.category);
    lines.push(budget ? `- ${c.category}: ${fmtEur(c.cents)} / ${fmtEur(budget)}` : `- ${c.category}: ${fmtEur(c.cents)}`);
  }
  if (beforeSpent > 0) {
    const diff = spent - beforeSpent;
    lines.push(`vs ${before}: ${diff >= 0 ? "+" : ""}${fmtEur(diff)}.`);
  }
  const gs = store.goals(deps.db);
  if (gs.length && balance > 0) {
    const g = gs[0];
    const remaining = Math.max(0, g.target_cents - g.saved_cents);
    const suggested = Math.min(balance, g.deadline ? Math.ceil(remaining / monthsUntil(today, g.deadline)) : remaining);
    if (suggested > 0) lines.push(`"${g.name}" could take ${fmtEur(suggested)} of that balance. /goal add if you do it.`);
  }
  if (await sendScheduled(deps, "last_monthly_report", month, lines.join("\n"))) {
    deps.log("job: monthly report sent");
  }
}

/** Fold conversations idle for 6h+ into one memory summary. Failure is fine — retried next day. */
export async function runCompaction(deps: JobDeps): Promise<void> {
  if (!deps.accountant) return;
  const now = deps.now();
  const cutoff = localTimestamp(new Date(now.getTime() - 6 * 3600_000), deps.config.timezone);
  const rows = store.uncompactedBefore(deps.db, cutoff);
  if (rows.length === 0) return;
  const transcript = rows.map((r) => `${r.role}: ${r.content}`).join("\n");
  const summary = await summarizeConversation(deps.accountant, transcript);
  if (!summary) {
    deps.log("job: compaction skipped (llm chain failed)");
    return;
  }
  store.addMemory(deps.db, localTimestamp(now, deps.config.timezone), summary);
  store.markCompacted(deps.db, rows.map((r) => r.id));
  deps.log(`job: compacted ${rows.length} messages into memory`);
}

function pattern(time: string, dayOfWeek: string, dayOfMonth = "*"): string {
  const [h, m] = time.split(":");
  return `${Number(m)} ${Number(h)} ${dayOfMonth} * ${dayOfWeek}`;
}

export function scheduleJobs(deps: JobDeps): Cron[] {
  const { config } = deps;
  const opts = { timezone: config.timezone, catch: (e: unknown) => deps.log(`job error: ${e instanceof Error ? e.message : String(e)}`) };
  const weeklyDow = DAY_CODES.indexOf(config.weeklyReportDay);
  return [
    new Cron(pattern(config.recapTime, "*"), opts, () => runDailyRecap(deps)),
    new Cron(pattern(config.weeklyReportTime, String(weeklyDow)), opts, () => runWeeklyReport(deps)),
    new Cron(pattern(config.monthlyReportTime, "*", "1"), opts, () => runMonthlyReport(deps)),
  ];
}
