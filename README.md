# accountant-bot

A single-user Telegram budget assistant. Her name is Odile (see `assets/accountant_system.md`). She logs expenses from casual messages and receipt photos, closes the day with a 21:30 recap, watches monthly per-category budgets, tracks income and savings goals, and sends weekly/monthly reports. Sibling project of `telegram-coach` — same architecture (grammY, better-sqlite3, Vercel AI SDK provider chain, croner).

## What she does

- **Log by talking**: "coffee 2.50", "j'ai payé 15 € de courses hier" — any language (EN/FR/MG), relative dates OK. She mirrors your language.
- **Receipt photos**: send a photo, she reads it and logs the total (needs a vision-capable provider: Anthropic, OpenAI or xAI — DeepSeek is text-only).
- **Instant commands** (no LLM): `/spent 12.50 dining coffee`, `/income 2100 salary`.
- **Daily close**: at `RECAP_TIME` she sends today's entries, budget status, and asks what's missing.
- **Budgets**: `/budget groceries 300` — she warns once at 80% and once at 100%, per category per month.
- **Goals**: `/goal vacation 1500 2027-06-01` — progress and suggested monthly set-aside.
- **Reports**: weekly (Sunday evening) and monthly (the 1st).
- **Export**: `/export`, `/export 2026-06`, `/export all` → CSV file.
- `/today /week /month /budgets /goals /undo /pause /resume /profile /model /categories /reset /help`

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather), copy the token.
2. `cp .env.example .env`, fill in `TELEGRAM_BOT_TOKEN` and at least one LLM API key.
3. `npm install && npm run dev` — leave `OWNER_CHAT_ID=0` (setup mode), send `/start` to the bot; it replies with your chat id.
4. Put the id in `.env` as `OWNER_CHAT_ID`, restart. Every other chat is silently dropped.

Check that the model ids in `LLM_MODEL` / `LLM_FALLBACKS` still exist before first run — model ids retire.

## Deploy (systemd)

```sh
# On the server (build there: better-sqlite3 is a native module)
sudo useradd -r -m -d /opt/accountant-bot accountant
sudo -u accountant git clone <repo> /opt/accountant-bot
cd /opt/accountant-bot && sudo -u accountant npm ci && sudo -u accountant npm run build
sudo -u accountant cp .env.example .env   # then edit
sudo cp deploy/accountant-bot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now accountant-bot
```

Backups: `npm run backup` copies the SQLite file next to itself with a date suffix; cron it daily. Note: it's a plain file copy of a WAL database — fine when the bot is idle at backup time; use `sqlite3 <db> ".backup <dest>"` if you want a guaranteed-consistent snapshot.

## Development

- `npm run dev` — run from source (tsx). `DRY_RUN=true` logs outgoing messages instead of sending.
- `npm test` — vitest, fully network-free (in-memory SQLite, fake LLM/send/clock).
- `npm run build && npm start` — compiled run.

## Architecture notes

- One structured LLM response (Zod-validated) carries both the reply bubbles and the DB mutations (expenses, income, budget/goal/profile updates) — applied by `applyResponse` in `src/handlers.ts`.
- Amounts cross the LLM boundary in **euros** and are stored/computed in **integer cents** everywhere else.
- Budget warnings are reply bubbles fired by `checkBudgetCrossings` right after an expense lands — not scheduled pings.
- Scheduled sends (`sendScheduled`) are idempotent per period (day/ISO week/month) and are logged into conversation history so she understands your answer to the recap question. `/pause` silences them.
- Conversation memory: 48h/30-message window; older messages are compacted into rolling summaries during the nightly recap job.
- The download URL for Telegram files embeds the bot token — it is never logged.
