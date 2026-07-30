import Database from "better-sqlite3";
import fs from "node:fs";
import { dirname } from "node:path";
import { monthEnd, monthStart } from "./time.js";

export type Db = Database.Database;

export type ExpenseSource = "chat" | "command" | "receipt";

export interface Expense {
  id: number;
  date: string;
  amount_cents: number;
  category: string;
  description: string;
  source: ExpenseSource;
  created_ts: string;
}

export interface Income {
  id: number;
  date: string;
  amount_cents: number;
  label: string;
  description: string;
  created_ts: string;
}

export interface Goal {
  id: number;
  name: string;
  target_cents: number;
  saved_cents: number;
  deadline: string;
  achieved_at: string;
  created_ts: string;
}

export interface MessageRow {
  id: number;
  ts: string;
  role: "user" | "assistant";
  content: string;
  compacted: number;
}

export interface BudgetLine {
  category: string;
  budget_cents: number;
  spent_cents: number;
  remaining_cents: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  category TEXT NOT NULL DEFAULT 'other',
  description TEXT DEFAULT '',
  source TEXT DEFAULT 'chat' CHECK(source IN ('chat','command','receipt')),
  created_ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_expenses_cat ON expenses(category, date);

CREATE TABLE IF NOT EXISTS income (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  label TEXT DEFAULT '',
  description TEXT DEFAULT '',
  created_ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  category TEXT PRIMARY KEY,
  monthly_cents INTEGER NOT NULL CHECK(monthly_cents > 0)
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  target_cents INTEGER NOT NULL,
  saved_cents INTEGER NOT NULL DEFAULT 0,
  deadline TEXT DEFAULT '',
  achieved_at TEXT DEFAULT '',
  created_ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  compacted INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const DEFAULT_CATEGORIES = [
  "groceries", "dining", "transport", "housing", "utilities", "health",
  "entertainment", "shopping", "subscriptions", "travel", "other",
];

const SETTINGS_DEFAULTS: Record<string, string> = {
  paused_until: "",
  last_recap_date: "",
  last_weekly_report: "",
  last_monthly_report: "",
  last_nudge_date: "",
  categories: JSON.stringify(DEFAULT_CATEGORIES),
};

export function openDb(path = ":memory:"): Db {
  if (path !== ":memory:") fs.mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  const ins = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) ins.run(k, v);
  return db;
}

export function getSetting(db: Db, key: string, fallback = ""): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// ---- categories ----

export function categories(db: Db): string[] {
  try {
    const cats = JSON.parse(getSetting(db, "categories", JSON.stringify(DEFAULT_CATEGORIES)));
    return Array.isArray(cats) ? cats : DEFAULT_CATEGORIES;
  } catch {
    return DEFAULT_CATEGORIES;
  }
}

export function addCategory(db: Db, name: string): boolean {
  const cat = name.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]*$/.test(cat)) return false;
  const cats = categories(db);
  if (cats.includes(cat)) return false;
  setSetting(db, "categories", JSON.stringify([...cats, cat]));
  return true;
}

/** Map free text onto the canonical list; unknown → "other". */
export function normalizeCategory(db: Db, raw: string): string {
  const cat = raw.trim().toLowerCase();
  return categories(db).includes(cat) ? cat : "other";
}

// ---- expenses ----

export function addExpense(
  db: Db,
  e: { date: string; amount_cents: number; category?: string; description?: string; source?: ExpenseSource },
  createdTs: string,
): void {
  db.prepare(
    "INSERT INTO expenses (date, amount_cents, category, description, source, created_ts) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(e.date, e.amount_cents, e.category ?? "other", e.description ?? "", e.source ?? "chat", createdTs);
}

export function expensesOn(db: Db, date: string): Expense[] {
  return db.prepare("SELECT * FROM expenses WHERE date = ? ORDER BY id").all(date) as Expense[];
}

export function expensesBetween(db: Db, start: string, end: string): Expense[] {
  return db.prepare("SELECT * FROM expenses WHERE date >= ? AND date <= ? ORDER BY date, id").all(start, end) as Expense[];
}

export function deleteLastExpense(db: Db): Expense | null {
  const last = db.prepare("SELECT * FROM expenses ORDER BY id DESC LIMIT 1").get() as Expense | undefined;
  if (!last) return null;
  db.prepare("DELETE FROM expenses WHERE id = ?").run(last.id);
  return last;
}

// ---- income ----

export function addIncome(
  db: Db,
  i: { date: string; amount_cents: number; label?: string; description?: string },
  createdTs: string,
): void {
  db.prepare("INSERT INTO income (date, amount_cents, label, description, created_ts) VALUES (?, ?, ?, ?, ?)").run(
    i.date, i.amount_cents, i.label ?? "", i.description ?? "", createdTs,
  );
}

export function incomeBetween(db: Db, start: string, end: string): Income[] {
  return db.prepare("SELECT * FROM income WHERE date >= ? AND date <= ? ORDER BY date, id").all(start, end) as Income[];
}

export function incomeTotalBetween(db: Db, start: string, end: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM income WHERE date >= ? AND date <= ?")
    .get(start, end) as { total: number };
  return row.total;
}

// ---- aggregates ----

export function totalCentsBetween(db: Db, start: string, end: string): number {
  const row = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM expenses WHERE date >= ? AND date <= ?")
    .get(start, end) as { total: number };
  return row.total;
}

export function spentByCategory(db: Db, start: string, end: string): { category: string; cents: number }[] {
  return db.prepare(
    "SELECT category, SUM(amount_cents) AS cents FROM expenses WHERE date >= ? AND date <= ? GROUP BY category ORDER BY cents DESC",
  ).all(start, end) as { category: string; cents: number }[];
}

/** Per (month, category) totals for months in [fromMonth, toMonth], e.g. "2026-02".."2026-07". */
export function monthlyTotals(db: Db, fromMonth: string, toMonth: string): { month: string; category: string; cents: number }[] {
  return db.prepare(
    `SELECT substr(date, 1, 7) AS month, category, SUM(amount_cents) AS cents
     FROM expenses WHERE date >= ? AND date <= ?
     GROUP BY month, category ORDER BY month, cents DESC`,
  ).all(monthStart(fromMonth), monthEnd(toMonth)) as { month: string; category: string; cents: number }[];
}

// ---- budgets ----

/** Set a monthly budget. 0 removes it. */
export function setBudget(db: Db, category: string, monthlyCents: number): void {
  if (monthlyCents <= 0) {
    db.prepare("DELETE FROM budgets WHERE category = ?").run(category);
    return;
  }
  db.prepare(
    "INSERT INTO budgets (category, monthly_cents) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET monthly_cents = excluded.monthly_cents",
  ).run(category, monthlyCents);
}

export function budgets(db: Db): { category: string; monthly_cents: number }[] {
  return db.prepare("SELECT category, monthly_cents FROM budgets ORDER BY category").all() as {
    category: string; monthly_cents: number;
  }[];
}

/** Budgeted categories with this month's spend. Categories spent but unbudgeted are NOT included. */
export function budgetStatus(db: Db, month: string): BudgetLine[] {
  const spent = new Map(spentByCategory(db, monthStart(month), monthEnd(month)).map((s) => [s.category, s.cents]));
  return budgets(db).map((b) => {
    const s = spent.get(b.category) ?? 0;
    return { category: b.category, budget_cents: b.monthly_cents, spent_cents: s, remaining_cents: b.monthly_cents - s };
  });
}

// ---- goals ----

export function upsertGoal(
  db: Db,
  g: { name: string; target_cents?: number; deadline?: string },
  createdTs: string,
): void {
  const existing = db.prepare("SELECT id FROM goals WHERE name = ?").get(g.name) as { id: number } | undefined;
  if (existing) {
    if (g.target_cents !== undefined) db.prepare("UPDATE goals SET target_cents = ? WHERE id = ?").run(g.target_cents, existing.id);
    if (g.deadline !== undefined) db.prepare("UPDATE goals SET deadline = ? WHERE id = ?").run(g.deadline, existing.id);
    return;
  }
  db.prepare("INSERT INTO goals (name, target_cents, deadline, created_ts) VALUES (?, ?, ?, ?)").run(
    g.name, g.target_cents ?? 0, g.deadline ?? "", createdTs,
  );
}

/** Add to (or withdraw from) a goal's saved amount. Floored at 0. Returns the goal or null if unknown. */
export function addToGoal(db: Db, name: string, deltaCents: number): Goal | null {
  const goal = db.prepare("SELECT * FROM goals WHERE name = ?").get(name) as Goal | undefined;
  if (!goal) return null;
  const saved = Math.max(0, goal.saved_cents + deltaCents);
  db.prepare("UPDATE goals SET saved_cents = ? WHERE id = ?").run(saved, goal.id);
  return { ...goal, saved_cents: saved };
}

export function goals(db: Db, includeAchieved = false): Goal[] {
  const where = includeAchieved ? "" : "WHERE achieved_at = ''";
  return db.prepare(`SELECT * FROM goals ${where} ORDER BY id`).all() as Goal[];
}

export function getGoal(db: Db, name: string): Goal | null {
  return (db.prepare("SELECT * FROM goals WHERE name = ?").get(name) as Goal | undefined) ?? null;
}

export function closeGoal(db: Db, name: string, ts: string): boolean {
  const res = db.prepare("UPDATE goals SET achieved_at = ? WHERE name = ? AND achieved_at = ''").run(ts, name);
  return res.changes > 0;
}

// ---- conversation / memory / profile (coach patterns) ----

export function logMessage(db: Db, ts: string, role: "user" | "assistant", content: string): void {
  db.prepare("INSERT INTO messages (ts, role, content) VALUES (?, ?, ?)").run(ts, role, content);
}

/** Most recent messages since sinceTs, capped, in chronological order. */
export function recentMessages(db: Db, sinceTs: string, cap: number): MessageRow[] {
  const rows = db.prepare("SELECT * FROM messages WHERE ts >= ? ORDER BY id DESC LIMIT ?").all(sinceTs, cap) as MessageRow[];
  return rows.reverse();
}

export function uncompactedBefore(db: Db, cutoffTs: string): MessageRow[] {
  return db.prepare("SELECT * FROM messages WHERE compacted = 0 AND ts < ? ORDER BY id").all(cutoffTs) as MessageRow[];
}

export function markCompacted(db: Db, ids: number[]): void {
  const stmt = db.prepare("UPDATE messages SET compacted = 1 WHERE id = ?");
  for (const id of ids) stmt.run(id);
}

export function addMemory(db: Db, ts: string, summary: string): void {
  db.prepare("INSERT INTO memory (ts, summary) VALUES (?, ?)").run(ts, summary);
}

export function recentMemories(db: Db, n: number): string[] {
  const rows = db.prepare("SELECT summary FROM memory ORDER BY id DESC LIMIT ?").all(n) as { summary: string }[];
  return rows.reverse().map((r) => r.summary);
}

/** Durable facts about the user (payday, habits, priorities). Empty value deletes the key. */
export function setProfileFact(db: Db, key: string, value: string, ts: string): void {
  if (value.trim() === "") {
    db.prepare("DELETE FROM profile WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    "INSERT INTO profile (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value, ts);
}

export function profileFacts(db: Db): { key: string; value: string; updated_at: string }[] {
  return db.prepare("SELECT key, value, updated_at FROM profile ORDER BY key").all() as {
    key: string; value: string; updated_at: string;
  }[];
}

/** Wipe the conversational brain: raw messages + rolling memories. Ledger untouched. */
export function clearChat(db: Db): void {
  db.exec("DELETE FROM messages; DELETE FROM memory;");
}

/** Wipe the money record: expenses + income. Budgets, goals and chat untouched. */
export function clearLedger(db: Db): void {
  db.exec("DELETE FROM expenses; DELETE FROM income;");
}

export function clearBudgetsGoals(db: Db): void {
  db.exec("DELETE FROM budgets; DELETE FROM goals;");
}

export function clearProfile(db: Db): void {
  db.exec("DELETE FROM profile;");
}
