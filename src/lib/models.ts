import { supportedModels } from "@mozaik-ai/core";
import type { ModelCapability, ModelInfo, ProviderInfo } from "./factory-agents";
import { cursorProvider } from "./providers/cursor-models";

/** Mozaik's `{ endpoint, specification }` model type, which its package doesn't export by name. */
export type GenerativeModel = (typeof supportedModels)[number];

/**
 * A model provider the factory can run agents on. Mozaik's built-in providers are listed from `supportedModels`; a provider
 * implemented in the factory (a custom Mozaik `Endpoint`, e.g. the Cursor SDK) is one more entry in FACTORY_PROVIDERS.
 */
export type ModelProvider = {
  id: string;
  label: string;
  credentialEnv: string;
  note?: string;
  models: GenerativeModel[];
  /** The model the settings UI picks when this provider is selected. */
  defaultModel?: string;
  /** Display names by model name. */
  modelLabels?: Record<string, string>;
  /** Models listed without the provider confirming them (e.g. its catalog couldn't be loaded). */
  unverifiedModels?: string[];
  /** Other names lookups accept, by the model name they resolve to (e.g. a default saved before the catalog loaded). */
  aliases?: Record<string, string>;
};

/** A provider, or a function that lists it now, for providers whose models are discovered at runtime (cached by the provider). */
export type ProviderSource = ModelProvider | (() => Promise<ModelProvider>);

type ProviderMeta = Pick<ModelProvider, "label" | "credentialEnv" | "note">;

const MOZAIK_PROVIDERS: Record<string, ProviderMeta> = {
  openai: { label: "OpenAI", credentialEnv: "OPENAI_API_KEY" },
  anthropic: { label: "Anthropic", credentialEnv: "ANTHROPIC_API_KEY" },
  google: { label: "Google Gemini", credentialEnv: "GEMINI_API_KEY" },
  deepseek: {
    label: "DeepSeek",
    credentialEnv: "OPENAI_API_KEY",
    note: "Mozaik calls DeepSeek through the OpenAI client, so it needs OPENAI_API_KEY and OPENAI_BASE_URL pointed at DeepSeek (which then applies to OpenAI models too).",
  },
};

/** Providers whose endpoints live in the factory rather than in Mozaik. Cursor's models come from the account's catalog. */
export const FACTORY_PROVIDERS: ProviderSource[] = [() => cursorProvider()];

export function mozaikProviders(): ModelProvider[] {
  const byId = new Map<string, ModelProvider>();
  for (const model of supportedModels) {
    const id = model.specification.provider;
    const provider = byId.get(id) ?? { id, ...(MOZAIK_PROVIDERS[id] ?? { label: id, credentialEnv: `${id.toUpperCase()}_API_KEY` }), models: [] };
    provider.models.push(model);
    byId.set(id, provider);
  }
  return [...byId.values()];
}

export function capabilities(model: GenerativeModel): ModelCapability[] {
  const { supportsFunctionCalling, supportsStructuredOutput } = model.specification;
  return [...(supportsFunctionCalling ? (["functionCalling"] as const) : []), ...(supportsStructuredOutput ? (["structuredOutput"] as const) : [])];
}

/** Merges providers by id; a later model with the same provider and name replaces the earlier one. */
function snapshot(providers: ModelProvider[]) {
  const merged = new Map<string, ModelProvider>();
  for (const provider of providers) {
    const existing = merged.get(provider.id);
    const models = new Map((existing?.models ?? []).map((m) => [m.specification.name, m]));
    for (const model of provider.models) models.set(model.specification.name, model);
    merged.set(provider.id, { ...existing, ...provider, models: [...models.values()] });
  }
  const list = [...merged.values()];
  const lookup = (provider: ModelProvider | undefined, model: string) => {
    const name = provider?.aliases?.[model] ?? model;
    return provider?.models.find((m) => m.specification.name === name);
  };
  return {
    providers: list,
    find: (provider: string, model: string) => lookup(merged.get(provider), model),
    /** The first provider offering `model`, for MOZAIK_MODEL which names a model only. */
    findByName: (model: string) => {
      for (const provider of list) {
        const found = lookup(provider, model);
        if (found) return { provider: provider.id, model: found };
      }
    },
    /** What the settings UI shows; credentials are reported as set or not, never their values. */
    describe: (): ProviderInfo[] =>
      list.map(({ id, label, credentialEnv, note, models, defaultModel, modelLabels, unverifiedModels }) => ({
        id,
        label,
        credentialEnv,
        credentialSet: Boolean(process.env[credentialEnv]?.trim()),
        ...(note && { note }),
        ...(defaultModel && models.some((m) => m.specification.name === defaultModel) && { defaultModel }),
        models: models.map((m): ModelInfo => {
          const { name, contextWindowSize } = m.specification;
          const label = modelLabels?.[name];
          return {
            name,
            ...(label && label !== name && { label }),
            ...(contextWindowSize > 0 && { contextWindowSize }),
            capabilities: capabilities(m),
            ...(unverifiedModels?.includes(name) && { unverified: true }),
          };
        }),
      })),
  };
}

export type RegistrySnapshot = ReturnType<typeof snapshot>;

/** The providers' models as of now; call `load()` for every lookup, since runtime-discovered models can change. */
export function createModelRegistry(sources: ProviderSource[]) {
  return {
    load: async () => snapshot(await Promise.all(sources.map((source) => (typeof source === "function" ? source() : source)))),
  };
}

export type ModelRegistry = ReturnType<typeof createModelRegistry>;

export const modelRegistry = createModelRegistry([...mozaikProviders(), ...FACTORY_PROVIDERS]);
