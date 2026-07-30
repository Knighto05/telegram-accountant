import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import {
  callAccountant,
  modelChain,
  switchModel,
  type AccountantDeps,
  type GenerateFn,
  type Registry,
} from "../src/accountant.js";

const NOW = new Date("2026-07-18T10:00:00+02:00");

const cfg = loadConfig({
  TELEGRAM_BOT_TOKEN: "test",
  OWNER_CHAT_ID: "1",
  TIMEZONE: "Europe/Paris",
  LLM_MODEL: "anthropic:model-a",
  LLM_FALLBACKS: "deepseek:model-d,xai:model-x,openai:model-o",
} as NodeJS.ProcessEnv);

function registryWith(...providers: string[]): Registry {
  return new Map(providers.map((p) => [p, (id: string) => ({ provider: p, id })])) as Registry;
}

const GOOD = { messages: ["ok"] };

describe("model chain", () => {
  test("active model first, fallbacks in order, keyless providers skipped", () => {
    const db = openDb();
    const registry = registryWith("anthropic", "xai");
    expect(modelChain(db, cfg, registry)).toEqual(["anthropic:model-a", "xai:model-x"]);
  });

  test("active model is read from settings, not just .env", () => {
    const db = openDb();
    const registry = registryWith("anthropic", "deepseek", "xai");
    expect(switchModel(db, registry, "deepseek:model-d")).toBeNull();
    expect(modelChain(db, cfg, registry)).toEqual(["deepseek:model-d", "xai:model-x"]);
  });

  test("switchModel rejects unknown providers and missing keys", () => {
    const db = openDb();
    const registry = registryWith("anthropic");
    expect(switchModel(db, registry, "mistral:le-chat")).toBe("unknown-provider:mistral");
    expect(switchModel(db, registry, "openai:model-o")).toBe("no-key:openai");
  });
});

describe("vision filtering", () => {
  test("vision drops deepseek from the chain", () => {
    const db = openDb();
    const registry = registryWith("anthropic", "deepseek", "xai");
    expect(modelChain(db, cfg, registry, { vision: true })).toEqual(["anthropic:model-a", "xai:model-x"]);
  });

  test("vision with an active deepseek model still finds a vision fallback", () => {
    const db = openDb();
    const registry = registryWith("deepseek", "openai");
    switchModel(db, registry, "deepseek:model-d");
    expect(modelChain(db, cfg, registry, { vision: true })).toEqual(["openai:model-o"]);
  });

  test("deepseek-only registry has an empty vision chain -> callAccountant returns null", async () => {
    const db = openDb();
    const registry = registryWith("deepseek");
    switchModel(db, registry, "deepseek:model-d");
    const generate: GenerateFn = async () => {
      throw new Error("should not be called");
    };
    const deps: AccountantDeps = { db, config: cfg, registry, generate, log: () => {} };
    const resp = await callAccountant(deps, [{ type: "text", text: "receipt" }], NOW, { vision: true });
    expect(resp).toBeNull();
  });
});

describe("fallback walking", () => {
  function deps(db: ReturnType<typeof openDb>, registry: Registry, generate: GenerateFn): AccountantDeps {
    return { db, config: cfg, registry, generate, log: () => {} };
  }

  test("API failure on the active model -> retry once, then next provider serves", async () => {
    const db = openDb();
    const calls: string[] = [];
    const generate: GenerateFn = async (args) => {
      const m = args.model as { provider: string };
      calls.push(m.provider);
      if (m.provider === "anthropic") throw new Error("529 overloaded");
      return { object: GOOD };
    };
    const resp = await callAccountant(deps(db, registryWith("anthropic", "deepseek"), generate), "hi", NOW);
    expect(resp!.messages).toEqual(["ok"]);
    expect(calls).toEqual(["anthropic", "anthropic", "deepseek"]);
  });

  test("invalid shape counts as a failure and falls through", async () => {
    const db = openDb();
    const generate: GenerateFn = async (args) => {
      const m = args.model as { provider: string };
      if (m.provider === "anthropic") return { object: { nonsense: true } };
      return { object: GOOD };
    };
    const resp = await callAccountant(deps(db, registryWith("anthropic", "xai"), generate), "hi", NOW);
    expect(resp!.messages).toEqual(["ok"]);
  });

  test("whole chain exhausted -> null", async () => {
    const db = openDb();
    const generate: GenerateFn = async () => {
      throw new Error("down");
    };
    const resp = await callAccountant(deps(db, registryWith("anthropic", "openai"), generate), "hi", NOW);
    expect(resp).toBeNull();
  });
});
