// Every fixed string the bot can say lives here, so tone can be reviewed in one place.
// Register: precise, brief, sharp-tongued — she judges the spending (with relish), never the person.
// Fixed strings stay short and language-light; the LLM handles language mirroring in conversation.

import { fmtEur } from "./money.js";

export const MSG = {
  // Command acknowledgments
  spentAck: (cents: number, category: string, date: string) =>
    `Noted: ${fmtEur(cents)} — ${category}, ${date}.`,
  incomeAck: (cents: number, label: string, date: string) =>
    `Noted: +${fmtEur(cents)}${label ? ` (${label})` : ""}, ${date}.`,
  SPENT_USAGE: "Usage: /spent 12.50 [category] [description] — e.g. /spent 4.50 dining coffee",
  INCOME_USAGE: "Usage: /income 2100 [label] — e.g. /income 2100 salary",
  UNDO_EMPTY: "Nothing to undo.",
  undoOk: (cents: number, category: string, date: string) =>
    `Removed: ${fmtEur(cents)} ${category} on ${date}.`,
  paused: (until: string) => `Paused — no scheduled messages until ${until}.`,
  PAUSE_USAGE: "Usage: /pause 7 (days).",
  RESUMED: "Resumed. The daily recap is back on.",
  BUDGET_USAGE: "Usage: /budget groceries 300 — or /budget groceries off — or /budgets to list",
  budgetSet: (category: string, cents: number) => `Budget set: ${category} ${fmtEur(cents)}/month.`,
  budgetOff: (category: string) => `Budget removed for ${category}.`,
  NO_BUDGETS: "No budgets set. Try: /budget groceries 300",
  GOAL_USAGE: [
    "Usage:",
    "/goal <name> <target> [deadline YYYY-MM-DD] — create or update",
    "/goal add <name> <amount> — record money set aside",
    "/goal done <name> — mark achieved",
    "/goals — progress",
  ].join("\n"),
  goalSet: (name: string, cents: number) => `Goal "${name}": target ${fmtEur(cents)}.`,
  goalUnknown: (name: string) => `No goal named "${name}". See /goals.`,
  goalAdded: (name: string, saved: number, target: number) =>
    `"${name}": ${fmtEur(saved)} / ${fmtEur(target)}.`,
  goalDone: (name: string) => `Goal "${name}" marked achieved. Well earned.`,
  NO_GOALS: "No savings goals yet. Try: /goal vacation 1500 2027-06-01",
  NO_EXPENSES: "No expenses recorded for that period.",
  EXPORT_USAGE: "Usage: /export — current month | /export 2026-06 | /export all",
  modelSet: (spec: string) => `Model switched to ${spec}.`,
  modelUnknownProvider: (p: string) => `Unknown provider "${p}". Providers: anthropic, openai, xai, deepseek.`,
  modelNoKey: (p: string) => `No API key set for ${p} — model unchanged.`,
  CATEGORIES_USAGE: "Usage: /categories — list | /categories add <name>",
  categoryAdded: (name: string) => `Category added: ${name}.`,
  categoryRejected: (name: string) => `Couldn't add "${name}" — lowercase letters/digits, and it must be new.`,

  // Budget threshold warnings (appended as extra bubbles when an expense crosses a line)
  budgetWarning80: (category: string, spent: number, budget: number) =>
    `${category}: ${fmtEur(spent)} of ${fmtEur(budget)}. 80% gone and the month is not. Impressive, in the wrong direction.`,
  budgetOver: (category: string, spent: number, budget: number) =>
    `${category} is over budget: ${fmtEur(spent)} of ${fmtEur(budget)}. Noted. That category is now a spectator sport until the 1st.`,

  // Photo / receipt flow
  RECEIPT_DOWNLOAD_FAILED: "Couldn't download that photo — nothing was logged. Try sending it again.",
  RECEIPT_TOO_LARGE: "That photo is too large for me to process. A regular photo (not file) works best.",
  NO_VISION_MODEL:
    "I can't read photos with the current model setup — no vision-capable provider (anthropic, openai or xai) has an API key. Type the amounts instead.",

  // Fallback when the whole LLM chain fails — the bot never goes silent-and-broken.
  API_FALLBACK: "Couldn't process that (API hiccup) — nothing was logged. Try again, or use /spent 12.50 category.",

  // Daily recap closing question — logged to history so the LLM understands the reply.
  RECAP_ASK: "Anything you spent today that isn't in the ledger yet? Reply here and I'll note it.",
  RECAP_NOTHING: "Nothing logged today.",
};
