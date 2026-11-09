import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { supportedModels } from "@mozaik-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentModels } from "./agent-models";
import { createModelRegistry, FACTORY_PROVIDERS, modelRegistry, mozaikProviders, type GenerativeModel } from "./models";
import { cursorProvider, type CatalogResult } from "./providers/cursor-models";

let dir: string;
let catalog: CatalogResult;
/** The real registry, with Cursor's catalog injected instead of loaded from the network. */
const withCatalog = createModelRegistry([...mozaikProviders(), () => cursorProvider({ get: async () => catalog })]);
const CATALOG = [
  { id: "composer-2.5", displayName: "Composer 2.5" },
  { id: "grok-4-7", displayName: "Grok 4.7", variants: [{ displayName: "High", params: [{ id: "effort", value: "high" }], isDefault: true }] },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
];
let file: string;
const env = {
  MOZAIK_MODEL: process.env.MOZAIK_MODEL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  CURSOR_API_KEY: process.env.CURSOR_API_KEY,
  CURSOR_DEFAULT_MODEL: process.env.CURSOR_DEFAULT_MODEL,
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-models-"));
  file = path.join(dir, "agent-models.json");
  delete process.env.MOZAIK_MODEL;
  delete process.env.CURSOR_API_KEY;
  delete process.env.CURSOR_DEFAULT_MODEL;
  catalog = { source: "catalog", models: CATALOG };
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("agent models", () => {
  it("falls back to MOZAIK_MODEL, resolving its provider from the registry", async () => {
    const models = createAgentModels(file);
    expect(await models.resolve("implement")).toMatchObject({ model: "gpt-5.5", provider: "openai", source: "env", supported: true });
    process.env.MOZAIK_MODEL = "claude-sonnet-5-5";
    expect(await models.resolve("review")).toMatchObject({ model: "claude-sonnet-5-5", provider: "anthropic", source: "env", supported: true });
    process.env.MOZAIK_MODEL = "nope";
    expect(await models.resolve("review")).toMatchObject({ model: "nope", provider: undefined, supported: false, generative: undefined });
  });

  it("persists a model per agent, and null falls back to the default again", async () => {
    await createAgentModels(file).save({ implement: { provider: "anthropic", model: "claude-opus-5-5" }, review: { provider: "google", model: "gemini-3.1-pro-preview" } });

    const reopened = createAgentModels(file);
    const implement = await reopened.resolve("implement");
    expect(implement).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", source: "settings", supported: true });
    expect(implement.generative).toBe((await modelRegistry.load()).find("anthropic", "claude-opus-5-5"));
    expect(await reopened.resolve("review")).toMatchObject({ provider: "google", model: "gemini-3.1-pro-preview", source: "settings" });

    await reopened.save({ implement: null });
    expect(await reopened.resolve("implement")).toMatchObject({ model: "gpt-5.5", source: "env" });
    expect(await reopened.resolve("review")).toMatchObject({ model: "gemini-3.1-pro-preview", source: "settings" });
  });

  it("rejects unknown models and models missing a capability the agent needs, saving nothing", async () => {
    const models = createAgentModels(file);
    await expect(models.save({ implement: { provider: "openai", model: "gpt-5.4" }, review: { provider: "deepseek", model: "deepseek-v4-pro" } })).rejects.toThrow(
      /review: deepseek-v4-pro doesn't support structured output, which the code reviewer needs/,
    );
    await expect(models.save({ implement: { provider: "anthropic", model: "gpt-5.5" } })).rejects.toThrow(/unknown model anthropic\/gpt-5.5/);
    await expect(readFile(file, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await models.save({ implement: { provider: "deepseek", model: "deepseek-v4-pro" } });
    expect(await models.resolve("implement")).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro" });
  });

  it("marks a saved model the registry no longer knows as unsupported instead of switching models", async () => {
    const custom: GenerativeModel = { ...supportedModels[0], specification: { ...supportedModels[0].specification, name: "custom-1", provider: "acme" } };
    const withAcme = createModelRegistry([{ id: "acme", label: "Acme", credentialEnv: "ACME_API_KEY", models: [custom] }]);
    await createAgentModels(file, withAcme).save({ implement: { provider: "acme", model: "custom-1" } });
    expect(await createAgentModels(file).resolve("implement")).toMatchObject({ provider: "acme", model: "custom-1", source: "settings", supported: false });
  });

  it("lists every Cursor catalog model, defaulting to Grok 4.7, without exposing CURSOR_API_KEY", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-do-not-leak";
    const view = await createAgentModels(file, withCatalog).view();
    expect(JSON.stringify(view)).not.toContain("cursor-test-do-not-leak");
    const cursor = view.providers.find((p) => p.id === "cursor");
    expect(cursor).toMatchObject({ label: "Cursor", credentialEnv: "CURSOR_API_KEY", credentialSet: true, defaultModel: "grok-4-7" });
    const both = ["functionCalling", "structuredOutput"];
    expect(cursor?.models).toEqual([
      { name: "composer-2.5", label: "Composer 2.5", capabilities: both },
      { name: "grok-4-7", label: "Grok 4.7", capabilities: both },
      { name: "gpt-5.6-sol", label: "GPT-5.6 Sol", capabilities: both },
    ]);
  });

  it("accepts any catalog model for both agents, rejects unknown ones, and marks models that leave the catalog unsupported", async () => {
    const models = createAgentModels(file, withCatalog);
    await models.save({ implement: { provider: "cursor", model: "grok-4-7" }, review: { provider: "cursor", model: "gpt-5.6-sol" } });
    const implement = await models.resolve("implement");
    expect(implement).toMatchObject({ provider: "cursor", model: "grok-4-7", source: "settings", supported: true });
    expect(implement.generative?.specification.name).toBe("grok-4-7");
    expect(await models.resolve("review")).toMatchObject({ provider: "cursor", model: "gpt-5.6-sol", supported: true });

    await expect(models.save({ implement: { provider: "cursor", model: "composer-9" } })).rejects.toThrow(/implement: unknown model cursor\/composer-9/);
    await expect(models.save({ review: { provider: "cursor", model: "grok-4.8" } })).rejects.toThrow(/review: unknown model cursor\/grok-4.8/);
    await expect(models.save({ review: { provider: "openai", model: "grok-4-7" } })).rejects.toThrow(/unknown model openai\/grok-4-7/);

    catalog = { source: "catalog", models: CATALOG.filter((m) => m.id !== "gpt-5.6-sol") };
    expect(await models.resolve("review")).toMatchObject({ provider: "cursor", model: "gpt-5.6-sol", source: "settings", supported: false, generative: undefined });
    expect((await models.view()).agents.find((a) => a.agent === "review")?.effective.supported).toBe(false);

    process.env.MOZAIK_MODEL = "grok-4-7";
    await models.save({ implement: null });
    expect(await models.resolve("implement")).toMatchObject({ provider: "cursor", model: "grok-4-7", source: "env", supported: true });
  });

  it("falls back to the default and Composer as unverified known models when the catalog can't be loaded", async () => {
    catalog = { source: "fallback", reason: "CURSOR_API_KEY is not set" };
    const models = createAgentModels(file, withCatalog);
    const cursor = (await models.view()).providers.find((p) => p.id === "cursor");
    expect(cursor).toMatchObject({ credentialSet: false, defaultModel: "grok-4.7", note: expect.stringContaining("CURSOR_API_KEY is not set") });
    expect(cursor?.models).toEqual([
      { name: "grok-4.7", capabilities: ["functionCalling", "structuredOutput"], unverified: true },
      { name: "composer-2.5", capabilities: ["functionCalling", "structuredOutput"], unverified: true },
    ]);
    await models.save({ implement: { provider: "cursor", model: "grok-4.7" }, review: { provider: "cursor", model: "composer-2.5" } });
    expect(await models.resolve("review")).toMatchObject({ provider: "cursor", model: "composer-2.5", supported: true });
    await expect(models.save({ review: { provider: "cursor", model: "gpt-5.6-sol" } })).rejects.toThrow(/unknown model cursor\/gpt-5.6-sol/);

    catalog = { source: "catalog", models: CATALOG };
    const implement = await models.resolve("implement");
    expect(implement).toMatchObject({ provider: "cursor", model: "grok-4.7", supported: true });
    expect(implement.generative?.specification.name).toBe("grok-4-7");
  });

  it("reports whether a provider's credential is set without exposing it", async () => {
    process.env.OPENAI_API_KEY = "sk-test-do-not-leak";
    const view = await createAgentModels(file).view();
    expect(JSON.stringify(view)).not.toContain("sk-test-do-not-leak");
    expect(view.providers.find((p) => p.id === "openai")).toMatchObject({ credentialEnv: "OPENAI_API_KEY", credentialSet: true });
    expect(view.agents.map((a) => a.agent)).toEqual(["implement", "review"]);
    expect(view.defaultModel).toEqual({ provider: "openai", model: "gpt-5.5", source: "env", supported: true });
  });
});

describe("model registry", () => {
  it("includes the Cursor provider, which lists known models without calling Cursor when no key is set", async () => {
    expect(FACTORY_PROVIDERS).toHaveLength(1);
    const registry = await modelRegistry.load();
    const cursor = registry.providers.find((p) => p.id === "cursor");
    expect(cursor).toMatchObject({ label: "Cursor", credentialEnv: "CURSOR_API_KEY", defaultModel: "grok-4.7" });
    expect(cursor?.models.map((m) => m.specification.name)).toEqual(["grok-4.7", "composer-2.5"]);
    expect(registry.findByName("composer-2.5")).toEqual({ provider: "cursor", model: registry.find("cursor", "composer-2.5") });
    expect((await modelRegistry.load()).find("cursor", "grok-4.7")).toBe(registry.find("cursor", "grok-4.7"));
  });

  it("lists Mozaik's providers and lets factory providers add or replace models", async () => {
    const base = mozaikProviders();
    expect(base.map((p) => p.id)).toEqual(expect.arrayContaining(["openai", "anthropic", "google", "deepseek"]));
    const composer: GenerativeModel = { ...supportedModels[0], specification: { ...supportedModels[0].specification, name: "composer-2.5", provider: "cursor" } };
    const real = await modelRegistry.load();
    const gpt = real.find("openai", "gpt-5.5")!;
    const override: GenerativeModel = { ...gpt, endpoint: { ...gpt.endpoint } };
    const registry = await createModelRegistry([
      ...base,
      async () => ({ id: "cursor", label: "Cursor", credentialEnv: "CURSOR_API_KEY", models: [composer] }),
      { id: "openai", label: "OpenAI", credentialEnv: "OPENAI_API_KEY", models: [override] },
    ]).load();
    expect(registry.find("cursor", "composer-2.5")).toBe(composer);
    expect(registry.findByName("composer-2.5")).toEqual({ provider: "cursor", model: composer });
    expect(registry.find("openai", "gpt-5.5")).toBe(override);
    expect(registry.find("openai", "gpt-5.4")).toBe(real.find("openai", "gpt-5.4"));
    expect(registry.describe().find((p) => p.id === "cursor")).toMatchObject({ label: "Cursor", credentialSet: false, models: [{ name: "composer-2.5" }] });
  });
});
