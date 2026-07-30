import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { addExpense, addIncome, openDb, recentMessages, setBudget, setSetting } from "../src/db.js";
import { runDailyRecap, runMonthlyReport, runWeeklyReport, sendNudge, sendScheduled } from "../src/jobs.js";
import { MSG } from "../src/messages.js";

// 2026-07-18 is a Saturday.
const NOW = "2026-07-18T21:30:00+02:00";
const TS = "2026-07-18T10:00:00";

const cfg = loadConfig({
  TELEGRAM_BOT_TOKEN: "test",
  OWNER_CHAT_ID: "1",
  TIMEZONE: "Europe/Paris",
} as NodeJS.ProcessEnv);

function setup(nowIso = NOW) {
  const db = openDb();
  const sent: string[] = [];
  const deps = {
    db,
    config: cfg,
    send: async (t: string) => {
      sent.push(t);
    },
    now: () => new Date(nowIso),
    log: () => {},
  };
  return { db, sent, deps };
}

describe("sendScheduled", () => {
  test("fires once per period, then goes quiet", async () => {
    const { sent, deps } = setup();
    expect(await sendScheduled(deps, "last_recap_date", "2026-07-18", "recap")).toBe(true);
    expect(await sendScheduled(deps, "last_recap_date", "2026-07-18", "recap again")).toBe(false);
    expect(await sendScheduled(deps, "last_recap_date", "2026-07-19", "next day")).toBe(true);
    expect(sent).toEqual(["recap", "next day"]);
  });

  test("no daily cap across different scheduled keys", async () => {
    const { sent, deps } = setup();
    await sendScheduled(deps, "last_recap_date", "2026-07-18", "recap");
    await sendScheduled(deps, "last_weekly_report", "2026-W29", "weekly");
    expect(sent).toHaveLength(2);
  });

  test("paused suppresses scheduled sends", async () => {
    const { db, sent, deps } = setup();
    setSetting(db, "paused_until", "2026-07-30");
    expect(await sendScheduled(deps, "last_recap_date", "2026-07-18", "recap")).toBe(false);
    expect(sent).toEqual([]);
  });

  test("scheduled sends land in conversation history as assistant", async () => {
    const { db, deps } = setup();
    await sendScheduled(deps, "last_recap_date", "2026-07-18", "recap text");
    const msgs = recentMessages(db, "2026-01-01T00:00:00", 10);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].content).toBe("recap text");
  });
});

describe("sendNudge", () => {
  test("hard once-per-day cap", async () => {
    const { sent, deps } = setup();
    expect(await sendNudge(deps, "first")).toBe(true);
    expect(await sendNudge(deps, "second")).toBe(false);
    expect(sent).toEqual(["first"]);
  });
});

describe("runDailyRecap", () => {
  test("with expenses: totals, budget lines that moved, and the question", async () => {
    const { db, sent, deps } = setup();
    setBudget(db, "groceries", 30000);
    addExpense(db, { date: "2026-07-18", amount_cents: 4200, category: "dining" }, TS);
    addExpense(db, { date: "2026-07-18", amount_cents: 8000, category: "groceries" }, TS);
    await runDailyRecap(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("122.00 €");
    expect(sent[0]).toContain("groceries: 220.00 € left this month");
    expect(sent[0]).toContain(MSG.RECAP_ASK);
    // dining has no budget — it appears in the breakdown but gets no budget line
    expect(sent[0]).not.toMatch(/dining.*left this month/);
  });

  test("empty day still asks the question", async () => {
    const { sent, deps } = setup();
    await runDailyRecap(deps);
    expect(sent[0]).toContain(MSG.RECAP_NOTHING);
    expect(sent[0]).toContain(MSG.RECAP_ASK);
  });

  test("idempotent within a day", async () => {
    const { sent, deps } = setup();
    await runDailyRecap(deps);
    await runDailyRecap(deps);
    expect(sent).toHaveLength(1);
  });
});

describe("runWeeklyReport", () => {
  test("includes previous-week comparison and is keyed by ISO week", async () => {
    const { db, sent, deps } = setup();
    // Week of 2026-07-13..19; previous week 07-06..12.
    addExpense(db, { date: "2026-07-15", amount_cents: 5000, category: "dining" }, TS);
    addExpense(db, { date: "2026-07-08", amount_cents: 3000, category: "dining" }, TS);
    await runWeeklyReport(deps);
    await runWeeklyReport(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("50.00 €");
    expect(sent[0]).toContain("Last week: 30.00 € (+20.00 €)");
  });
});

describe("runMonthlyReport", () => {
  test("closes the previous month with income, balance and trend", async () => {
    const { db, sent, deps } = setup("2026-08-01T09:00:00+02:00");
    addExpense(db, { date: "2026-07-10", amount_cents: 60000, category: "groceries" }, TS);
    addExpense(db, { date: "2026-06-10", amount_cents: 40000, category: "groceries" }, TS);
    addIncome(db, { date: "2026-07-01", amount_cents: 210000, label: "salary" }, TS);
    setBudget(db, "groceries", 50000);
    await runMonthlyReport(deps);
    await runMonthlyReport(deps);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Month 2026-07 closed.");
    expect(sent[0]).toContain("Spent 600.00 €, income 2100.00 €, balance +1500.00 €");
    expect(sent[0]).toContain("groceries: 600.00 € / 500.00 €");
    expect(sent[0]).toContain("vs 2026-06: +200.00 €");
  });
});
