import { InputFile, type Bot, type Context } from "grammy";
import type { Config } from "./config.js";
import * as store from "./db.js";
import type { Db, ExpenseSource } from "./db.js";
import { MSG } from "./messages.js";
import { fmtEur, parseAmountToCents } from "./money.js";
import { expensesToCsv } from "./csv.js";
import { addDays, isoWeekStart, localDate, localTimestamp, monthEnd, monthOf, monthStart, monthsUntil } from "./time.js";
import {
  activeModel,
  callAccountant,
  splitSpec,
  switchModel,
  type AccountantDeps,
  type AccountantResponse,
  type UserContent,
} from "./accountant.js";

export interface HandlerDeps {
  db: Db;
  config: Config;
  accountant: AccountantDeps;
  now: () => Date;
  log: (msg: string) => void;
}

/**
 * Apply a structured accountant response to the DB. Exported for tests.
 * Returns the categories touched by inserted expenses (for budget-warning checks).
 */
export function applyResponse(
  db: Db,
  resp: AccountantResponse,
  ts: string,
  source: ExpenseSource = "chat",
): string[] {
  const touched: string[] = [];
  for (const e of resp.expenses) {
    const category = store.normalizeCategory(db, e.category);
    store.addExpense(
      db,
      { date: e.date, amount_cents: Math.round(e.amount_eur * 100), category, description: e.description, source },
      ts,
    );
    touched.push(category);
  }
  for (const i of resp.income) {
    store.addIncome(db, { date: i.date, amount_cents: Math.round(i.amount_eur * 100), label: i.label, description: i.description }, ts);
  }
  for (const b of resp.budget_updates) {
    store.setBudget(db, store.normalizeCategory(db, b.category), Math.round(b.monthly_eur * 100));
  }
  for (const g of resp.goal_updates) {
    if (g.target_eur !== undefined || g.deadline !== undefined || !store.getGoal(db, g.name)) {
      store.upsertGoal(
        db,
        { name: g.name, target_cents: g.target_eur !== undefined ? Math.round(g.target_eur * 100) : undefined, deadline: g.deadline },
        ts,
      );
    }
    if (g.add_saved_eur) store.addToGoal(db, g.name, Math.round(g.add_saved_eur * 100));
    if (g.close) store.closeGoal(db, g.name, ts);
  }
  for (const u of resp.profile_updates) {
    store.setProfileFact(db, u.key, u.value, ts);
  }
  return touched;
}

/**
 * After expenses land in `categories`, report budget thresholds newly crossed this month
 * (80% and 100%), each at most once per month per category (flagged in settings).
 * These ride along as extra reply bubbles — crossings only happen during user turns.
 */
export function checkBudgetCrossings(db: Db, month: string, categories: string[]): string[] {
  const warnings: string[] = [];
  const status = new Map(store.budgetStatus(db, month).map((b) => [b.category, b]));
  for (const cat of new Set(categories)) {
    const line = status.get(cat);
    if (!line) continue;
    const key = `budget_warned:${month}:${cat}`;
    const warned = store.getSetting(db, key, "");
    const ratio = line.spent_cents / line.budget_cents;
    if (ratio >= 1 && warned !== "100") {
      warnings.push(MSG.budgetOver(cat, line.spent_cents, line.budget_cents));
      store.setSetting(db, key, "100");
    } else if (ratio >= 0.8 && ratio < 1 && warned === "") {
      warnings.push(MSG.budgetWarning80(cat, line.spent_cents, line.budget_cents));
      store.setSetting(db, key, "80");
    }
  }
  return warnings;
}

/** How long she "types" before a follow-up bubble: scales with length, jittered, capped. */
export function typingDelayMs(text: string, rand: () => number = Math.random): number {
  const base = 600 + text.length * 35;
  return Math.min(Math.round(base * (0.8 + rand() * 0.4)), 3500);
}

/** Deterministic period summary used by /today /week /month and the daily recap. */
export function periodStatus(db: Db, start: string, end: string, label: string): string {
  const total = store.totalCentsBetween(db, start, end);
  if (total === 0) return `${label}: nothing logged.`;
  const byCat = store.spentByCategory(db, start, end);
  return [`${label}: ${fmtEur(total)}`, ...byCat.map((c) => `- ${c.category}: ${fmtEur(c.cents)}`)].join("\n");
}

export function monthStatus(db: Db, month: string): string {
  const start = monthStart(month);
  const end = monthEnd(month);
  const spent = store.totalCentsBetween(db, start, end);
  const income = store.incomeTotalBetween(db, start, end);
  const balance = income - spent;
  const lines = [
    `Month ${month}`,
    `Spent: ${fmtEur(spent)} | Income: ${fmtEur(income)} | Balance: ${balance >= 0 ? "+" : ""}${fmtEur(balance)}`,
  ];
  const status = store.budgetStatus(db, month);
  if (status.length) {
    lines.push("Budgets:");
    for (const b of status) {
      lines.push(
        b.remaining_cents < 0
          ? `- ${b.category}: ${fmtEur(b.spent_cents)} / ${fmtEur(b.budget_cents)} (over by ${fmtEur(-b.remaining_cents)})`
          : `- ${b.category}: ${fmtEur(b.spent_cents)} / ${fmtEur(b.budget_cents)}`,
      );
    }
  }
  const budgeted = new Set(status.map((b) => b.category));
  const rest = store.spentByCategory(db, start, end).filter((c) => !budgeted.has(c.category));
  if (rest.length) lines.push("Other spending: " + rest.map((c) => `${c.category} ${fmtEur(c.cents)}`).join(", "));
  return lines.join("\n");
}

function goalsStatus(db: Db, today: string): string {
  const gs = store.goals(db);
  if (gs.length === 0) return MSG.NO_GOALS;
  return gs
    .map((g) => {
      const pct = g.target_cents > 0 ? Math.round((g.saved_cents / g.target_cents) * 100) : 0;
      const remaining = Math.max(0, g.target_cents - g.saved_cents);
      const suggest = g.deadline
        ? ` — set aside ${fmtEur(Math.ceil(remaining / monthsUntil(today, g.deadline)))}/month for ${g.deadline}`
        : "";
      return `"${g.name}": ${fmtEur(g.saved_cents)} / ${fmtEur(g.target_cents)} (${pct}%)${suggest}`;
    })
    .join("\n");
}

const HELP = [
  "Log spending by just telling me, or:",
  "/spent 12.50 [category] [note] — instant log, no AI",
  "/income 2100 [label] — log money in",
  "/today /week /month — where the money went",
  "/budget groceries 300 — monthly budget (off to remove)",
  "/budgets — budgets vs spending",
  "/goal, /goals — savings goals",
  "/export [YYYY-MM|all] — CSV of the ledger",
  "/undo — remove the last expense",
  "/categories — the category list",
  "/pause 7, /resume — silence scheduled messages",
  "/profile — what I remember about your money",
  "/model — show or switch the LLM",
  "/reset — wipe data by scope",
  "You can also send a photo of a receipt.",
].join("\n");

export function registerHandlers(bot: Bot, deps: HandlerDeps): void {
  const { db, config } = deps;
  const today = () => localDate(deps.now(), config.timezone);
  const nowTs = () => localTimestamp(deps.now(), config.timezone);

  const reply = async (ctx: Context, text: string) => {
    if (config.dryRun) {
      deps.log(`[dry-run] reply: ${text}`);
      return;
    }
    await ctx.reply(text);
  };

  // Security boundary: every update is dropped unless it comes from the owner chat.
  // Exception: with OWNER_CHAT_ID unset (setup mode), /start reveals the chat id.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (config.ownerChatId !== 0 && chatId === config.ownerChatId) return next();
    if (config.ownerChatId === 0 && ctx.message?.text?.startsWith("/start")) {
      await ctx.reply(`Your chat id: ${chatId}\nPut it in .env as OWNER_CHAT_ID and restart the bot.`);
    }
    // Anyone else: no reply, no content logging, just drop.
  });

  bot.command("start", (ctx) => reply(ctx, `You're set. Chat id: ${ctx.chat.id}.`));
  bot.command("help", (ctx) => reply(ctx, HELP));

  bot.command("spent", async (ctx) => {
    const parts = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const cents = parts[0] ? parseAmountToCents(parts[0]) : null;
    if (cents === null) return reply(ctx, MSG.SPENT_USAGE);
    let rest = parts.slice(1);
    let category = "other";
    if (rest[0] && store.categories(db).includes(rest[0].toLowerCase())) {
      category = rest[0].toLowerCase();
      rest = rest.slice(1);
    }
    store.addExpense(db, { date: today(), amount_cents: cents, category, description: rest.join(" "), source: "command" }, nowTs());
    deps.log(`expense logged via /spent: ${cents} ${category}`);
    await reply(ctx, MSG.spentAck(cents, category, today()));
    for (const w of checkBudgetCrossings(db, monthOf(today()), [category])) await reply(ctx, w);
  });

  bot.command("income", async (ctx) => {
    const parts = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const cents = parts[0] ? parseAmountToCents(parts[0]) : null;
    if (cents === null) return reply(ctx, MSG.INCOME_USAGE);
    const label = parts.slice(1).join(" ");
    store.addIncome(db, { date: today(), amount_cents: cents, label }, nowTs());
    await reply(ctx, MSG.incomeAck(cents, label, today()));
  });

  bot.command("today", (ctx) => reply(ctx, periodStatus(db, today(), today(), `Today ${today()}`)));

  bot.command("week", (ctx) => {
    const start = isoWeekStart(today());
    return reply(ctx, periodStatus(db, start, addDays(start, 6), `Week from ${start}`));
  });

  bot.command("month", (ctx) => reply(ctx, monthStatus(db, monthOf(today()))));

  bot.command("budget", async (ctx) => {
    const parts = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length !== 2) return reply(ctx, MSG.BUDGET_USAGE);
    const category = parts[0].toLowerCase();
    if (!store.categories(db).includes(category)) {
      return reply(ctx, `Unknown category "${category}". See /categories (or /categories add ${category}).`);
    }
    if (parts[1].toLowerCase() === "off") {
      store.setBudget(db, category, 0);
      return reply(ctx, MSG.budgetOff(category));
    }
    const cents = parseAmountToCents(parts[1]);
    if (cents === null) return reply(ctx, MSG.BUDGET_USAGE);
    store.setBudget(db, category, cents);
    return reply(ctx, MSG.budgetSet(category, cents));
  });

  bot.command("budgets", (ctx) => {
    const month = monthOf(today());
    const status = store.budgetStatus(db, month);
    if (status.length === 0) return reply(ctx, MSG.NO_BUDGETS);
    const lines = status.map((b) =>
      b.remaining_cents < 0
        ? `${b.category}: ${fmtEur(b.spent_cents)} / ${fmtEur(b.budget_cents)} — over by ${fmtEur(-b.remaining_cents)}`
        : `${b.category}: ${fmtEur(b.spent_cents)} / ${fmtEur(b.budget_cents)} — ${fmtEur(b.remaining_cents)} left`,
    );
    return reply(ctx, [`Budgets ${month}:`, ...lines].join("\n"));
  });

  bot.command("goal", async (ctx) => {
    const parts = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return reply(ctx, MSG.GOAL_USAGE);
    const sub = parts[0].toLowerCase();
    if (sub === "add" && parts.length >= 3) {
      const cents = parseAmountToCents(parts[parts.length - 1]);
      const name = parts.slice(1, -1).join(" ");
      if (cents === null) return reply(ctx, MSG.GOAL_USAGE);
      const goal = store.addToGoal(db, name, cents);
      if (!goal) return reply(ctx, MSG.goalUnknown(name));
      return reply(ctx, MSG.goalAdded(name, goal.saved_cents, goal.target_cents));
    }
    if (sub === "done" && parts.length >= 2) {
      const name = parts.slice(1).join(" ");
      if (!store.closeGoal(db, name, nowTs())) return reply(ctx, MSG.goalUnknown(name));
      return reply(ctx, MSG.goalDone(name));
    }
    // /goal <name...> <target> [deadline]
    let deadline: string | undefined;
    let end = parts.length;
    if (/^\d{4}-\d{2}-\d{2}$/.test(parts[end - 1])) {
      deadline = parts[end - 1];
      end--;
    }
    const cents = end >= 2 ? parseAmountToCents(parts[end - 1]) : null;
    const name = parts.slice(0, end - 1).join(" ");
    if (cents === null || !name) return reply(ctx, MSG.GOAL_USAGE);
    store.upsertGoal(db, { name, target_cents: cents, deadline }, nowTs());
    return reply(ctx, MSG.goalSet(name, cents));
  });

  bot.command("goals", (ctx) => reply(ctx, goalsStatus(db, today())));

  bot.command("export", async (ctx) => {
    const arg = (ctx.match ?? "").trim().toLowerCase();
    let rows, name;
    if (arg === "" || /^\d{4}-\d{2}$/.test(arg)) {
      const month = arg || monthOf(today());
      rows = store.expensesBetween(db, monthStart(month), monthEnd(month));
      name = `expenses-${month}.csv`;
    } else if (arg === "all") {
      rows = store.expensesBetween(db, "0000-01-01", "9999-12-31");
      name = "expenses-all.csv";
    } else {
      return reply(ctx, MSG.EXPORT_USAGE);
    }
    if (rows.length === 0) return reply(ctx, MSG.NO_EXPENSES);
    if (config.dryRun) {
      deps.log(`[dry-run] export: ${name} (${rows.length} rows)`);
      return;
    }
    await ctx.replyWithDocument(new InputFile(Buffer.from(expensesToCsv(rows), "utf8"), name));
  });

  bot.command("undo", async (ctx) => {
    const removed = store.deleteLastExpense(db);
    return reply(ctx, removed ? MSG.undoOk(removed.amount_cents, removed.category, removed.date) : MSG.UNDO_EMPTY);
  });

  bot.command("categories", async (ctx) => {
    const parts = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return reply(ctx, `Categories: ${store.categories(db).join(", ")}`);
    if (parts[0].toLowerCase() === "add" && parts[1]) {
      const name = parts[1].toLowerCase();
      return reply(ctx, store.addCategory(db, name) ? MSG.categoryAdded(name) : MSG.categoryRejected(name));
    }
    return reply(ctx, MSG.CATEGORIES_USAGE);
  });

  bot.command("model", async (ctx) => {
    const spec = (ctx.match ?? "").trim();
    if (!spec) {
      const available = [...deps.accountant.registry.keys()].join(", ") || "none (no API keys set)";
      return reply(ctx, `Active: ${activeModel(db, config)}\nProviders with keys: ${available}`);
    }
    const err = switchModel(db, deps.accountant.registry, spec);
    if (err === null) return reply(ctx, MSG.modelSet(spec));
    const [kind, provider] = err.split(":");
    return reply(ctx, kind === "no-key" ? MSG.modelNoKey(provider) : MSG.modelUnknownProvider(splitSpec(spec)[0]));
  });

  bot.command("pause", async (ctx) => {
    const n = Number((ctx.match ?? "").trim() || "7");
    if (!Number.isInteger(n) || n < 1 || n > 365) return reply(ctx, MSG.PAUSE_USAGE);
    const until = addDays(today(), n);
    store.setSetting(db, "paused_until", until);
    return reply(ctx, MSG.paused(until));
  });

  bot.command("resume", async (ctx) => {
    store.setSetting(db, "paused_until", "");
    return reply(ctx, MSG.RESUMED);
  });

  // Testing/cleanup: wipe stored data by scope. Ledger wipes need an explicit "yes".
  bot.command("reset", async (ctx) => {
    const [scope, confirm] = (ctx.match ?? "").trim().toLowerCase().split(/\s+/);
    const USAGE = [
      "Usage:",
      "/reset chat — clear conversation + her memories (ledger kept)",
      "/reset ledger yes — clear expenses + income",
      "/reset all yes — everything, plus budgets, goals and the profile",
      "Settings (model, categories) always survive.",
    ].join("\n");
    if (scope === "chat") {
      store.clearChat(db);
      return reply(ctx, "Chat + memories cleared. She starts fresh.");
    }
    if (scope === "ledger" || scope === "all") {
      if (confirm !== "yes") return reply(ctx, `This deletes your money records. To confirm: /reset ${scope} yes`);
      store.clearLedger(db);
      if (scope === "all") {
        store.clearChat(db);
        store.clearBudgetsGoals(db);
        store.clearProfile(db);
      }
      return reply(ctx, scope === "all" ? "Everything cleared (ledger, budgets, goals, chat, profile)." : "Expenses + income cleared.");
    }
    return reply(ctx, USAGE);
  });

  // What she durably believes about the user's money. She maintains it; this is the audit surface.
  bot.command("profile", async (ctx) => {
    const [sub, key, ...rest] = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (!sub) {
      const facts = store.profileFacts(db);
      if (facts.length === 0)
        return reply(ctx, "Profile is empty. She fills it as you talk (payday, rent, subscriptions). Manual: /profile set <key> <value>, /profile del <key>");
      return reply(ctx, ["What she knows about your money:", ...facts.map((f) => `${f.key}: ${f.value}`)].join("\n"));
    }
    if (sub === "del" && key) {
      store.setProfileFact(db, key, "", nowTs());
      return reply(ctx, `Removed ${key}.`);
    }
    if (sub === "set" && key && rest.length) {
      store.setProfileFact(db, key, rest.join(" "), nowTs());
      return reply(ctx, `Saved ${key}.`);
    }
    return reply(ctx, "Usage: /profile — show all | /profile set <key> <value> | /profile del <key>");
  });

  /** Shared tail of every LLM turn: apply, warn, send bubbles. */
  const finishTurn = async (ctx: Context, resp: AccountantResponse, source: ExpenseSource) => {
    const touched = applyResponse(db, resp, nowTs(), source);
    const bubbles = [...resp.messages, ...checkBudgetCrossings(db, monthOf(today()), touched)];
    for (let i = 0; i < bubbles.length; i++) {
      if (i > 0 && !config.dryRun) {
        await ctx.replyWithChatAction("typing");
        await new Promise((r) => setTimeout(r, typingDelayMs(bubbles[i])));
      }
      store.logMessage(db, nowTs(), "assistant", bubbles[i]);
      await reply(ctx, bubbles[i]);
    }
  };

  // Any non-command text goes to the accountant.
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    store.logMessage(db, nowTs(), "user", text);
    deps.log(`accountant turn: user message (${text.length} chars)`);
    const resp = await callAccountant(deps.accountant, text, deps.now());
    if (!resp) return reply(ctx, MSG.API_FALLBACK);
    await finishTurn(ctx, resp, "chat");
  });

  // Receipt photos: download the largest size, hand it to a vision-capable model.
  bot.on("message:photo", async (ctx) => {
    const caption = ctx.message.caption ?? "";
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    if (largest.file_size && largest.file_size > 10 * 1024 * 1024) return reply(ctx, MSG.RECEIPT_TOO_LARGE);

    let image: Buffer;
    try {
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("no file_path");
      // The download URL embeds the bot token — never log it.
      const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${file.file_path}`);
      if (!res.ok) throw new Error(`download status ${res.status}`);
      image = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      deps.log(`receipt download failed (file_id ${largest.file_id}): ${err instanceof Error ? err.message : String(err)}`);
      return reply(ctx, MSG.RECEIPT_DOWNLOAD_FAILED);
    }

    // History stays text-only: the window never replays the image.
    store.logMessage(db, nowTs(), "user", `[receipt photo]${caption ? ` ${caption}` : ""}`);
    deps.log(`accountant turn: receipt photo (${image.length} bytes)`);

    const content: UserContent = [
      { type: "image", image, mediaType: "image/jpeg" },
      { type: "text", text: caption || "Receipt photo. Extract and log the expense(s)." },
    ];
    const resp = await callAccountant(deps.accountant, content, deps.now(), { vision: true });
    if (!resp) {
      const anyVision = ["anthropic", "openai", "xai"].some((p) => deps.accountant.registry.has(p as never));
      return reply(ctx, anyVision ? MSG.API_FALLBACK : MSG.NO_VISION_MODEL);
    }
    await finishTurn(ctx, resp, "receipt");
  });
}
