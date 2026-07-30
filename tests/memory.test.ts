import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { logMessage, openDb, recentMemories, uncompactedBefore } from "../src/db.js";
import { buildWindow, type AccountantDeps, type GenerateFn, type Registry } from "../src/accountant.js";
import { runCompaction } from "../src/jobs.js";

const NOW = new Date("2026-07-18T21:30:00+02:00");
const TZ = "Europe/Paris";

const cfg = loadConfig({
  TELEGRAM_BOT_TOKEN: "test",
  OWNER_CHAT_ID: "1",
  TIMEZONE: TZ,
  LLM_MODEL: "anthropic:model-a",
} as NodeJS.ProcessEnv);

describe("buildWindow", () => {
  test("only the last 48h, capped at 30, chronological, mapped to model roles", () => {
    const db = openDb();
    logMessage(db, "2026-07-10T09:00:00", "user", "ancient");
    for (let i = 0; i < 35; i++) {
      logMessage(db, `2026-07-18T10:${String(i).padStart(2, "0")}:00`, i % 2 ? "assistant" : "user", `m${i}`);
    }
    const win = buildWindow(db, NOW, TZ);
    expect(win).toHaveLength(30);
    expect(win[0].content).toBe("m5"); // the 30 most recent of 35
    expect(win.at(-1)!.content).toBe("m34");
    expect(win.some((m) => m.content === "ancient")).toBe(false);
    expect(win[0].role).toBe("assistant"); // m5, odd index
  });
});

describe("runCompaction", () => {
  function deps(db: ReturnType<typeof openDb>, generate: GenerateFn) {
    const registry: Registry = new Map([["anthropic", (id: string) => ({ id })]]) as Registry;
    const accountant: AccountantDeps = { db, config: cfg, registry, generate, log: () => {} };
    return {
      db,
      config: cfg,
      send: async () => {},
      now: () => NOW,
      accountant,
      log: () => {},
    };
  }

  test("messages idle 6h+ become one memory and are marked compacted", async () => {
    const db = openDb();
    logMessage(db, "2026-07-18T09:00:00", "user", "spent 20 on gas");
    logMessage(db, "2026-07-18T09:00:05", "assistant", "noted");
    logMessage(db, "2026-07-18T21:00:00", "user", "recent — stays");
    const generate: GenerateFn = async () => ({ object: { summary: "logged 20 for gas" } });
    await runCompaction(deps(db, generate));
    expect(recentMemories(db, 5)).toEqual(["logged 20 for gas"]);
    expect(uncompactedBefore(db, "2099-01-01T00:00:00").map((r) => r.content)).toEqual(["recent — stays"]);
  });

  test("llm failure leaves messages uncompacted for the next run", async () => {
    const db = openDb();
    logMessage(db, "2026-07-18T09:00:00", "user", "old");
    const generate: GenerateFn = async () => {
      throw new Error("down");
    };
    await runCompaction(deps(db, generate));
    expect(recentMemories(db, 5)).toEqual([]);
    expect(uncompactedBefore(db, "2099-01-01T00:00:00")).toHaveLength(1);
  });
});
