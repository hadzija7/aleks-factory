import type { ModelListItem } from "@cursor/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASSUMED_GROK_MODEL, createCursorCatalog, cursorProvider, findCatalogModel, selectionFor, type CatalogResult } from "./cursor-models";

// Nothing reaches the network: the catalog is injected or comes from this mock.
const sdk = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@cursor/sdk", () => ({ Cursor: { models: { list: sdk.list } }, Agent: { prompt: vi.fn() }, emptyFs: vi.fn() }));

const env = { CURSOR_API_KEY: process.env.CURSOR_API_KEY, CURSOR_DEFAULT_MODEL: process.env.CURSOR_DEFAULT_MODEL };
beforeEach(() => {
  process.env.CURSOR_API_KEY = "cursor-secret-key";
  delete process.env.CURSOR_DEFAULT_MODEL;
  sdk.list.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

const CATALOG: ModelListItem[] = [
  { id: "composer-2.5", displayName: "Composer 2.5", parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true", displayName: "Fast" }] }] },
  {
    id: "grok-4-7",
    displayName: "Grok 4.7",
    parameters: [{ id: "effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] }],
    variants: [
      { displayName: "Grok 4.7 xhigh (Max)", params: [{ id: "effort", value: "xhigh" }], isMaxMode: true, isDefault: true },
      { displayName: "Grok 4.7 high", params: [{ id: "effort", value: "high" }] },
    ],
  },
  { id: "grok-4-7-500k", displayName: "Grok 4.7 500k" },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
  { id: "auto-smart", displayName: "Auto", parameters: [{ id: "optimize_for", values: [{ value: "balanced" }, { value: "cost" }] }], variants: [{ displayName: "Cost", params: [{ id: "optimize_for", value: "cost" }], isDefault: true }] },
];

const catalogOf = (result: CatalogResult) => ({ get: async () => result });

describe("findCatalogModel", () => {
  it("matches an exact id or alias, else the same letters and digits in an id or display name", () => {
    expect(findCatalogModel(CATALOG, "gpt-5.6-sol")?.id).toBe("gpt-5.6-sol");
    expect(findCatalogModel([{ id: "x1", displayName: "X", aliases: ["grok-4.7"] }, ...CATALOG], "grok-4.7")?.id).toBe("x1");
    expect(findCatalogModel(CATALOG, ASSUMED_GROK_MODEL)?.id).toBe("grok-4-7");
    expect(findCatalogModel([{ id: "xai-g47", displayName: "Grok 4.7" }], "grok-4.7")?.id).toBe("xai-g47");
    expect(findCatalogModel([{ id: "grok-4.7-fast", displayName: "Fast" }, { id: "grok-4.7-500k-fast", displayName: "Long" }], "grok-4.7")?.id).toBe("grok-4.7-fast");
    expect(findCatalogModel(CATALOG, "claude-opus-5-5")).toBeUndefined();
  });
});

describe("selectionFor", () => {
  it("passes explicit params: the default non-Max variant, else each parameter's first value", () => {
    expect(selectionFor(CATALOG[1])).toEqual({ id: "grok-4-7", params: [{ id: "effort", value: "high" }] });
    expect(selectionFor(CATALOG[0])).toEqual({ id: "composer-2.5", params: [{ id: "fast", value: "false" }] });
    expect(selectionFor(CATALOG[4])).toEqual({ id: "auto-smart", params: [{ id: "optimize_for", value: "cost" }] });
    expect(selectionFor(CATALOG[3])).toEqual({ id: "gpt-5.6-sol" });
  });
});

describe("createCursorCatalog", () => {
  it("lists the account's models with CURSOR_API_KEY, cached until the TTL expires", async () => {
    let now = 0;
    const list = vi.fn(async () => CATALOG);
    const catalog = createCursorCatalog({ list, now: () => now, ttlMs: 1000 });
    const [first, concurrent] = await Promise.all([catalog.get(), catalog.get()]);
    expect(first).toEqual({ source: "catalog", models: CATALOG });
    expect(concurrent).toBe(first);
    now = 999;
    await catalog.get();
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith("cursor-secret-key");
    now = 1000;
    await catalog.get();
    expect(list).toHaveBeenCalledTimes(2);
    process.env.CURSOR_API_KEY = "another-key";
    await catalog.get();
    expect(list).toHaveBeenLastCalledWith("another-key");
  });

  it("calls Cursor.models.list by default (mocked here)", async () => {
    sdk.list.mockResolvedValue(CATALOG);
    expect(await createCursorCatalog().get()).toEqual({ source: "catalog", models: CATALOG });
    expect(sdk.list).toHaveBeenCalledWith({ apiKey: "cursor-secret-key" });
  });

  it("falls back without a key or when listing fails, keeps the last catalog on a failed refresh, and never echoes the key", async () => {
    delete process.env.CURSOR_API_KEY;
    const list = vi.fn(async (): Promise<ModelListItem[]> => {
      throw new Error("401 for key cursor-secret-key");
    });
    let now = 0;
    const catalog = createCursorCatalog({ list, now: () => now, ttlMs: 10, failureTtlMs: 5 });
    expect(await catalog.get()).toEqual({ source: "fallback", reason: "CURSOR_API_KEY is not set" });
    expect(list).not.toHaveBeenCalled();

    process.env.CURSOR_API_KEY = "cursor-secret-key";
    const failed = await catalog.get();
    expect(failed).toEqual({ source: "fallback", reason: "401 for key [redacted]" });
    expect(JSON.stringify(failed)).not.toContain("cursor-secret-key");
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("cursor-secret-key");
    now = 4;
    await catalog.get();
    expect(list).toHaveBeenCalledTimes(1);

    now = 5;
    list.mockResolvedValueOnce(CATALOG);
    expect(await catalog.get()).toMatchObject({ source: "catalog" });
    now = 20;
    expect(await catalog.get()).toEqual({ source: "stale", models: CATALOG, reason: "401 for key [redacted]" });
  });

  it("gives up on a catalog call that hangs", async () => {
    const catalog = createCursorCatalog({ list: () => new Promise(() => {}), timeoutMs: 10 });
    expect(await catalog.get()).toEqual({ source: "fallback", reason: "timed out after 0.01s" });
  });
});

describe("cursorProvider", () => {
  it("registers every catalog model with tool calling + structured output, defaulting to Grok 4.7", async () => {
    const provider = await cursorProvider(catalogOf({ source: "catalog", models: CATALOG }));
    expect(provider).toMatchObject({ id: "cursor", label: "Cursor", credentialEnv: "CURSOR_API_KEY", defaultModel: "grok-4-7" });
    expect(provider.models.map((m) => m.specification.name)).toEqual(CATALOG.map((m) => m.id));
    for (const model of provider.models) expect(model.specification).toMatchObject({ provider: "cursor", supportsFunctionCalling: true, supportsStructuredOutput: true });
    expect(provider.modelLabels).toMatchObject({ "grok-4-7": "Grok 4.7", "composer-2.5": "Composer 2.5" });
    expect(provider.unverifiedModels).toBeUndefined();
    expect(provider.note).not.toMatch(/isn't in this account's catalog/);
    const again = await cursorProvider(catalogOf({ source: "catalog", models: CATALOG }));
    expect(again.models[1]).toBe(provider.models[1]);
  });

  it("uses CURSOR_DEFAULT_MODEL, and says so when the default isn't in the catalog", async () => {
    process.env.CURSOR_DEFAULT_MODEL = "GPT 5.6 Sol";
    expect((await cursorProvider(catalogOf({ source: "catalog", models: CATALOG }))).defaultModel).toBe("gpt-5.6-sol");
    process.env.CURSOR_DEFAULT_MODEL = "grok-9";
    const provider = await cursorProvider(catalogOf({ source: "catalog", models: CATALOG }));
    expect(provider.defaultModel).toBeUndefined();
    expect(provider.note).toMatch(/The default model grok-9 isn't in this account's catalog/);
  });

  it("lists the default and Composer as unverified known models when the catalog is unavailable", async () => {
    const provider = await cursorProvider(catalogOf({ source: "fallback", reason: "CURSOR_API_KEY is not set" }));
    expect(provider.models.map((m) => m.specification.name)).toEqual([ASSUMED_GROK_MODEL, "composer-2.5"]);
    expect(provider).toMatchObject({ defaultModel: "grok-4.7", unverifiedModels: ["grok-4.7", "composer-2.5"] });
    expect(provider.note).toMatch(/Couldn't load this account's model catalog \(CURSOR_API_KEY is not set\)/);
    process.env.CURSOR_DEFAULT_MODEL = "composer-2.5";
    expect((await cursorProvider(catalogOf({ source: "fallback", reason: "x" }))).models.map((m) => m.specification.name)).toEqual(["composer-2.5"]);
  });

  it("keeps listing the last catalog when a refresh fails", async () => {
    const provider = await cursorProvider(catalogOf({ source: "stale", models: CATALOG, reason: "network down" }));
    expect(provider.models).toHaveLength(CATALOG.length);
    expect(provider.note).toMatch(/Showing the last loaded catalog; refreshing failed \(network down\)/);
  });
});
