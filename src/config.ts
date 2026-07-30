import "dotenv/config";

export type Provider = "anthropic" | "openai" | "xai" | "deepseek";

export const DAY_CODES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
export type DayCode = (typeof DAY_CODES)[number];

export interface Config {
  telegramToken: string;
  ownerChatId: number;
  apiKeys: Partial<Record<Provider, string>>;
  llmModel: string;
  llmFallbacks: string[];
  timezone: string;
  recapTime: string;
  weeklyReportDay: DayCode;
  weeklyReportTime: string;
  monthlyReportTime: string;
  dryRun: boolean;
  dbPath: string;
}

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

function time(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const v = env[key] ?? fallback;
  if (!TIME_RE.test(v)) throw new Error(`${key} must be HH:MM, got "${v}"`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const telegramToken = env.TELEGRAM_BOT_TOKEN ?? "";
  if (!telegramToken) throw new Error("TELEGRAM_BOT_TOKEN is required");

  const apiKeys: Config["apiKeys"] = {};
  if (env.ANTHROPIC_API_KEY) apiKeys.anthropic = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY) apiKeys.openai = env.OPENAI_API_KEY;
  if (env.XAI_API_KEY) apiKeys.xai = env.XAI_API_KEY;
  if (env.DEEPSEEK_API_KEY) apiKeys.deepseek = env.DEEPSEEK_API_KEY;

  const weeklyReportDay = (env.WEEKLY_REPORT_DAY ?? "SUN").toUpperCase() as DayCode;
  if (!DAY_CODES.includes(weeklyReportDay)) throw new Error(`WEEKLY_REPORT_DAY must be one of ${DAY_CODES.join(",")}`);

  return {
    telegramToken,
    ownerChatId: Number(env.OWNER_CHAT_ID ?? 0),
    apiKeys,
    llmModel: env.LLM_MODEL ?? "anthropic:claude-sonnet-4-6",
    llmFallbacks: (env.LLM_FALLBACKS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    timezone: env.TIMEZONE ?? "Europe/Paris",
    recapTime: time(env, "RECAP_TIME", "21:30"),
    weeklyReportDay,
    weeklyReportTime: time(env, "WEEKLY_REPORT_TIME", "18:00"),
    monthlyReportTime: time(env, "MONTHLY_REPORT_TIME", "09:00"),
    dryRun: (env.DRY_RUN ?? "false").toLowerCase() === "true",
    dbPath: env.ACCOUNTANT_DB_PATH ?? "./data/accountant.db",
  };
}
