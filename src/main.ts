import { Bot } from "grammy";
import { loadConfig } from "./config.js";
import { openDb, getSetting } from "./db.js";
import { buildRegistry, splitSpec, type AccountantDeps } from "./accountant.js";
import { registerHandlers } from "./handlers.js";
import { scheduleJobs } from "./jobs.js";

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const config = loadConfig();
const db = openDb(config.dbPath);
const registry = buildRegistry(config);

// Fail fast if the active model's provider has no key.
const active = getSetting(db, "llm_model", config.llmModel);
const [activeProvider] = splitSpec(active);
if (!registry.has(activeProvider)) {
  throw new Error(
    `Active model "${active}" needs an API key for provider "${activeProvider}". ` +
      `Set it in .env, or change LLM_MODEL. Providers with keys: ${[...registry.keys()].join(", ") || "none"}.`,
  );
}

const bot = new Bot(config.telegramToken);

// Populate Telegram's "/" command menu so the options are discoverable in-chat.
bot.api.setMyCommands([
  { command: "spent", description: "Log an expense: /spent 12.50 [category] [note]" },
  { command: "income", description: "Log money in: /income 2100 [label]" },
  { command: "today", description: "Today's spending" },
  { command: "week", description: "This week's spending" },
  { command: "month", description: "This month: spending, income, budgets" },
  { command: "budgets", description: "Budgets vs spending this month" },
  { command: "budget", description: "Set a budget: /budget groceries 300" },
  { command: "goals", description: "Savings goals progress" },
  { command: "export", description: "CSV export: /export [YYYY-MM|all]" },
  { command: "undo", description: "Remove the last logged expense" },
  { command: "pause", description: "Silence scheduled messages: /pause 7" },
  { command: "resume", description: "End the pause" },
  { command: "profile", description: "What she remembers about your money" },
  { command: "model", description: "Show or switch the LLM model" },
  { command: "reset", description: "Wipe data: /reset chat | ledger yes | all yes" },
  { command: "help", description: "All commands" },
]).catch((err) => log(`setMyCommands failed: ${err instanceof Error ? err.message : String(err)}`));

const now = () => new Date();
const accountant: AccountantDeps = { db, config, registry, log };

const send = async (text: string) => {
  if (config.dryRun) {
    log(`[dry-run] send: ${text}`);
    return;
  }
  await bot.api.sendMessage(config.ownerChatId, text);
};

registerHandlers(bot, { db, config, accountant, now, log });
const jobs = scheduleJobs({ db, config, send, now, accountant, log });

bot.catch((err) => log(`bot error: ${err.message}`));

const shutdown = async () => {
  log("shutting down");
  for (const j of jobs) j.stop();
  await bot.stop();
  db.close();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

log(
  `accountant-bot starting: model=${active}, tz=${config.timezone}, dry_run=${config.dryRun}, ` +
    `owner=${config.ownerChatId === 0 ? "UNSET (setup mode: /start reveals chat id)" : "set"}`,
);
bot.start().catch((err) => {
  log(`fatal: polling failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
