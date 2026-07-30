import { describe, expect, test } from "vitest";
import {
  addExpense,
  addIncome,
  addToGoal,
  budgetStatus,
  closeGoal,
  goals,
  incomeTotalBetween,
  monthlyTotals,
  normalizeCategory,
  openDb,
  setBudget,
  spentByCategory,
  totalCentsBetween,
  upsertGoal,
} from "../src/db.js";

const TS = "2026-07-18T10:00:00";

function seeded() {
  const db = openDb();
  addExpense(db, { date: "2026-07-01", amount_cents: 5000, category: "groceries" }, TS);
  addExpense(db, { date: "2026-07-10", amount_cents: 3000, category: "groceries" }, TS);
  addExpense(db, { date: "2026-07-10", amount_cents: 2000, category: "dining" }, TS);
  addExpense(db, { date: "2026-06-15", amount_cents: 7000, category: "groceries" }, TS);
  return db;
}

describe("aggregates", () => {
  test("totalCentsBetween respects the date range", () => {
    const db = seeded();
    expect(totalCentsBetween(db, "2026-07-01", "2026-07-31")).toBe(10000);
    expect(totalCentsBetween(db, "2026-07-05", "2026-07-31")).toBe(5000);
    expect(totalCentsBetween(db, "2026-08-01", "2026-08-31")).toBe(0);
  });

  test("spentByCategory groups and orders by amount", () => {
    const db = seeded();
    expect(spentByCategory(db, "2026-07-01", "2026-07-31")).toEqual([
      { category: "groceries", cents: 8000 },
      { category: "dining", cents: 2000 },
    ]);
  });

  test("monthlyTotals returns per month-category rows", () => {
    const db = seeded();
    const rows = monthlyTotals(db, "2026-06", "2026-07");
    expect(rows).toContainEqual({ month: "2026-06", category: "groceries", cents: 7000 });
    expect(rows).toContainEqual({ month: "2026-07", category: "groceries", cents: 8000 });
  });

  test("income totals are separate from expenses", () => {
    const db = seeded();
    addIncome(db, { date: "2026-07-01", amount_cents: 210000, label: "salary" }, TS);
    expect(incomeTotalBetween(db, "2026-07-01", "2026-07-31")).toBe(210000);
    expect(totalCentsBetween(db, "2026-07-01", "2026-07-31")).toBe(10000);
  });
});

describe("budgets", () => {
  test("budgetStatus computes spent and remaining per budgeted category", () => {
    const db = seeded();
    setBudget(db, "groceries", 30000);
    setBudget(db, "dining", 1500);
    expect(budgetStatus(db, "2026-07")).toEqual([
      { category: "dining", budget_cents: 1500, spent_cents: 2000, remaining_cents: -500 },
      { category: "groceries", budget_cents: 30000, spent_cents: 8000, remaining_cents: 22000 },
    ]);
  });

  test("setBudget with 0 removes the budget", () => {
    const db = openDb();
    setBudget(db, "groceries", 30000);
    setBudget(db, "groceries", 0);
    expect(budgetStatus(db, "2026-07")).toEqual([]);
  });
});

describe("goals", () => {
  test("contributions accumulate and floor at zero", () => {
    const db = openDb();
    upsertGoal(db, { name: "vacation", target_cents: 150000, deadline: "2027-06-01" }, TS);
    expect(addToGoal(db, "vacation", 20000)!.saved_cents).toBe(20000);
    expect(addToGoal(db, "vacation", -50000)!.saved_cents).toBe(0);
    expect(addToGoal(db, "nope", 100)).toBeNull();
  });

  test("upsert updates target/deadline without resetting saved", () => {
    const db = openDb();
    upsertGoal(db, { name: "vacation", target_cents: 150000 }, TS);
    addToGoal(db, "vacation", 30000);
    upsertGoal(db, { name: "vacation", target_cents: 200000, deadline: "2027-01-01" }, TS);
    const [g] = goals(db);
    expect(g.target_cents).toBe(200000);
    expect(g.deadline).toBe("2027-01-01");
    expect(g.saved_cents).toBe(30000);
  });

  test("closed goals leave the active list", () => {
    const db = openDb();
    upsertGoal(db, { name: "vacation", target_cents: 1000 }, TS);
    expect(closeGoal(db, "vacation", TS)).toBe(true);
    expect(goals(db)).toEqual([]);
    expect(goals(db, true)).toHaveLength(1);
    expect(closeGoal(db, "vacation", TS)).toBe(false);
  });
});

describe("categories", () => {
  test("normalizeCategory maps unknown to other", () => {
    const db = openDb();
    expect(normalizeCategory(db, "Groceries")).toBe("groceries");
    expect(normalizeCategory(db, "lambo")).toBe("other");
  });
});
