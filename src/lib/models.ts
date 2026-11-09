import { supportedModels } from "@mozaik-ai/core";
import type { ModelCapability, ModelInfo, ProviderInfo } from "./factory-agents";
import { composerModel, CURSOR_CREDENTIAL_ENV } from "./providers/cursor";

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
};

type ProviderMeta = Omit<ModelProvider, "id" | "models">;

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

/** Providers whose endpoints live in the factory rather than in Mozaik. */
export const FACTORY_PROVIDERS: ModelProvider[] = [
  {
    id: "cursor",
    label: "Cursor",
    credentialEnv: CURSOR_CREDENTIAL_ENV,
    note: "Composer via the Cursor SDK. Cursor runs the tool loop itself, so tool calls show up in Dash0 traces but not in the task activity feed.",
    models: [composerModel],
  },
];

function mozaikProviders(): ModelProvider[] {
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
export function createModelRegistry(providers: ModelProvider[]) {
  const merged = new Map<string, ModelProvider>();
  for (const provider of providers) {
    const existing = merged.get(provider.id);
    const models = new Map((existing?.models ?? []).map((m) => [m.specification.name, m]));
    for (const model of provider.models) models.set(model.specification.name, model);
    merged.set(provider.id, { ...existing, ...provider, models: [...models.values()] });
  }
  const list = [...merged.values()];
  return {
    providers: list,
    find: (provider: string, model: string) => merged.get(provider)?.models.find((m) => m.specification.name === model),
    /** The first provider offering `model`, for MOZAIK_MODEL which names a model only. */
    findByName: (model: string) => {
      for (const provider of list) {
        const found = provider.models.find((m) => m.specification.name === model);
        if (found) return { provider: provider.id, model: found };
      }
    },
    /** What the settings UI shows; credentials are reported as set or not, never their values. */
    describe: (): ProviderInfo[] =>
      list.map(({ id, label, credentialEnv, note, models }) => ({
        id,
        label,
        credentialEnv,
        credentialSet: Boolean(process.env[credentialEnv]?.trim()),
        ...(note && { note }),
        models: models.map((m): ModelInfo => ({
          name: m.specification.name,
          ...(m.specification.contextWindowSize > 0 && { contextWindowSize: m.specification.contextWindowSize }),
          capabilities: capabilities(m),
        })),
      })),
  };
}

export type ModelRegistry = ReturnType<typeof createModelRegistry>;

export const modelRegistry = createModelRegistry([...mozaikProviders(), ...FACTORY_PROVIDERS]);
