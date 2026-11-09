import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { supportedModels } from "@mozaik-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentModels } from "./agent-models";
import { createModelRegistry, modelRegistry, type GenerativeModel } from "./models";

let dir: string;
let file: string;
const env = { MOZAIK_MODEL: process.env.MOZAIK_MODEL, OPENAI_API_KEY: process.env.OPENAI_API_KEY };

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "agent-models-"));
  file = path.join(dir, "agent-models.json");
  delete process.env.MOZAIK_MODEL;
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
    expect(implement.generative).toBe(modelRegistry.find("anthropic", "claude-opus-5-5"));
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
  it("lists Mozaik's providers and lets factory providers add or replace models", () => {
    expect(modelRegistry.providers.map((p) => p.id)).toEqual(expect.arrayContaining(["openai", "anthropic", "google", "deepseek"]));
    const base = modelRegistry.providers;
    const composer: GenerativeModel = { ...supportedModels[0], specification: { ...supportedModels[0].specification, name: "composer-2.5", provider: "cursor" } };
    const gpt = modelRegistry.find("openai", "gpt-5.5")!;
    const override: GenerativeModel = { ...gpt, endpoint: { ...gpt.endpoint } };
    const registry = createModelRegistry([
      ...base,
      { id: "cursor", label: "Cursor", credentialEnv: "CURSOR_API_KEY", models: [composer] },
      { id: "openai", label: "OpenAI", credentialEnv: "OPENAI_API_KEY", models: [override] },
    ]);
    expect(registry.find("cursor", "composer-2.5")).toBe(composer);
    expect(registry.findByName("composer-2.5")).toEqual({ provider: "cursor", model: composer });
    expect(registry.find("openai", "gpt-5.5")).toBe(override);
    expect(registry.find("openai", "gpt-5.4")).toBe(modelRegistry.find("openai", "gpt-5.4"));
    expect(registry.describe().find((p) => p.id === "cursor")).toMatchObject({ label: "Cursor", credentialSet: false, models: [{ name: "composer-2.5" }] });
  });
});
