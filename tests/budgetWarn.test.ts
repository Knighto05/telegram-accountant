import { describe, expect, test } from "vitest";
import { checkBudgetCrossings } from "../src/handlers.js";
import { addExpense, openDb, setBudget } from "../src/db.js";

const TS = "2026-07-18T10:00:00";
const MONTH = "2026-07";

function spend(db: ReturnType<typeof openDb>, cents: number, category = "groceries") {
  addExpense(db, { date: "2026-07-18", amount_cents: cents, category }, TS);
}

describe("checkBudgetCrossings", () => {
  test("nothing without a budget", () => {
    const db = openDb();
    spend(db, 100000);
    expect(checkBudgetCrossings(db, MONTH, ["groceries"])).toEqual([]);
  });

  test("80% fires once, then 100% fires once", () => {
    const db = openDb();
    setBudget(db, "groceries", 10000);

    spend(db, 7000);
    expect(checkBudgetCrossings(db, MONTH, ["groceries"])).toEqual([]);

    spend(db, 1500); // 85%
    expect(checkBudgetCrossings(db, MONTH, ["groceries"])).toHaveLength(1);
    spend(db, 500); // 90% — already warned at 80
    expect(checkBudgetCrossings(db, MONTH, ["groceries"])).toEqual([]);

    spend(db, 2000); // 105%
    const over = checkBudgetCrossings(db, MONTH, ["groceries"]);
    expect(over).toHaveLength(1);
    expect(over[0]).toContain("over");
    spend(db, 1000);
    expect(checkBudgetCrossings(db, MONTH, ["groceries"])).toEqual([]);
  });

  test("jumping straight past 100% warns once, not twice", () => {
    const db = openDb();
    setBudget(db, "groceries", 10000);
    spend(db, 12000);
    expect(checkBudgetCrossings(db, MONTH, ["groceries"])).toHaveLength(1);
    expect(checkBudgetCrossings(db, MONTH, ["groceries"])).toEqual([]);
  });

  test("flags are per month: a new month warns again", () => {
    const db = openDb();
    setBudget(db, "groceries", 10000);
    spend(db, 9000);
    expect(checkBudgetCrossings(db, MONTH, ["groceries"])).toHaveLength(1);
    addExpense(db, { date: "2026-08-02", amount_cents: 9000, category: "groceries" }, TS);
    expect(checkBudgetCrossings(db, "2026-08", ["groceries"])).toHaveLength(1);
  });

  test("only the touched categories are checked", () => {
    const db = openDb();
    setBudget(db, "groceries", 10000);
    setBudget(db, "dining", 1000);
    spend(db, 9500, "groceries");
    spend(db, 900, "dining");
    expect(checkBudgetCrossings(db, MONTH, ["dining"])).toHaveLength(1);
    // groceries crossing untouched — will fire when groceries is next touched
    expect(checkBudgetCrossings(db, MONTH, ["groceries"])).toHaveLength(1);
  });
});
