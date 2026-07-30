import { describe, expect, test } from "vitest";
import { AccountantResponseSchema, coerceValue } from "../src/accountant.js";
import { applyResponse, typingDelayMs } from "../src/handlers.js";
import { budgets, expensesBetween, getGoal, goals, incomeBetween, openDb, profileFacts, setBudget, upsertGoal } from "../src/db.js";

const TS = "2026-07-18T10:00:00";

const BASE = {
  messages: ["ok"],
  expenses: [],
  income: [],
  budget_updates: [],
  goal_updates: [],
  profile_updates: [],
  summary: "",
};

describe("coerceValue", () => {
  test("accepts a valid object and fills defaults", () => {
    const parsed = coerceValue(AccountantResponseSchema, { messages: ["hi"] });
    expect(parsed).not.toBeNull();
    expect(parsed!.expenses).toEqual([]);
  });

  test("accepts fenced JSON strings", () => {
    const parsed = coerceValue(AccountantResponseSchema, '```json\n{"messages":["hi"]}\n```');
    expect(parsed!.messages).toEqual(["hi"]);
  });

  test("rejects invalid shapes", () => {
    expect(coerceValue(AccountantResponseSchema, { messages: [] })).toBeNull();
    expect(coerceValue(AccountantResponseSchema, "not json")).toBeNull();
    expect(
      coerceValue(AccountantResponseSchema, { messages: ["x"], expenses: [{ date: "18/07/2026", amount_eur: 5, category: "dining" }] }),
    ).toBeNull();
    expect(
      coerceValue(AccountantResponseSchema, { messages: ["x"], expenses: [{ date: "2026-07-18", amount_eur: -5, category: "dining" }] }),
    ).toBeNull();
  });
});

describe("applyResponse", () => {
  test("expenses land in cents with normalized categories; touched categories returned", () => {
    const db = openDb();
    const touched = applyResponse(
      db,
      {
        ...BASE,
        expenses: [
          { date: "2026-07-18", amount_eur: 4.2, category: "Dining", description: "coffee" },
          { date: "2026-07-17", amount_eur: 15.5, category: "weird-cat", description: "" },
        ],
      },
      TS,
    );
    const rows = expensesBetween(db, "2026-07-01", "2026-07-31");
    expect(rows.map((r) => [r.date, r.amount_cents, r.category, r.source])).toEqual([
      ["2026-07-17", 1550, "other", "chat"],
      ["2026-07-18", 420, "dining", "chat"],
    ]);
    expect(touched).toEqual(["dining", "other"]);
  });

  test("euro rounding is exact for classic float traps", () => {
    const db = openDb();
    applyResponse(db, { ...BASE, expenses: [{ date: "2026-07-18", amount_eur: 19.9, category: "shopping", description: "" }] }, TS);
    expect(expensesBetween(db, "2026-07-18", "2026-07-18")[0].amount_cents).toBe(1990);
  });

  test("source can be receipt", () => {
    const db = openDb();
    applyResponse(db, { ...BASE, expenses: [{ date: "2026-07-18", amount_eur: 30, category: "groceries", description: "" }] }, TS, "receipt");
    expect(expensesBetween(db, "2026-07-18", "2026-07-18")[0].source).toBe("receipt");
  });

  test("income is recorded", () => {
    const db = openDb();
    applyResponse(db, { ...BASE, income: [{ date: "2026-07-01", amount_eur: 2100, label: "salary", description: "" }] }, TS);
    expect(incomeBetween(db, "2026-07-01", "2026-07-31")[0].amount_cents).toBe(210000);
  });

  test("budget_updates set and remove budgets", () => {
    const db = openDb();
    applyResponse(db, { ...BASE, budget_updates: [{ category: "groceries", monthly_eur: 300 }] }, TS);
    expect(budgets(db)).toEqual([{ category: "groceries", monthly_cents: 30000 }]);
    applyResponse(db, { ...BASE, budget_updates: [{ category: "groceries", monthly_eur: 0 }] }, TS);
    expect(budgets(db)).toEqual([]);
  });

  test("goal_updates create, contribute and close", () => {
    const db = openDb();
    applyResponse(
      db,
      { ...BASE, goal_updates: [{ name: "vacation", target_eur: 1500, deadline: "2027-06-01", add_saved_eur: 100, close: false }] },
      TS,
    );
    const g = getGoal(db, "vacation")!;
    expect([g.target_cents, g.saved_cents, g.deadline]).toEqual([150000, 10000, "2027-06-01"]);

    applyResponse(db, { ...BASE, goal_updates: [{ name: "vacation", add_saved_eur: -25, close: false }] }, TS);
    expect(getGoal(db, "vacation")!.saved_cents).toBe(7500);

    applyResponse(db, { ...BASE, goal_updates: [{ name: "vacation", close: true }] }, TS);
    expect(goals(db)).toEqual([]);
  });

  test("contribution to an existing goal does not reset its target", () => {
    const db = openDb();
    upsertGoal(db, { name: "vacation", target_cents: 150000 }, TS);
    applyResponse(db, { ...BASE, goal_updates: [{ name: "vacation", add_saved_eur: 50, close: false }] }, TS);
    const g = getGoal(db, "vacation")!;
    expect([g.target_cents, g.saved_cents]).toEqual([150000, 5000]);
  });

  test("profile updates are stored", () => {
    const db = openDb();
    applyResponse(db, { ...BASE, profile_updates: [{ key: "income.payday", value: "28th" }] }, TS);
    expect(profileFacts(db)).toEqual([{ key: "income.payday", value: "28th", updated_at: TS }]);
  });
});

describe("typingDelayMs", () => {
  test("scales with length and stays capped", () => {
    expect(typingDelayMs("hi", () => 0.5)).toBe(670);
    expect(typingDelayMs("x".repeat(500), () => 0.5)).toBe(3500);
  });
});
