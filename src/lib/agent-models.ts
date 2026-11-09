import path from "node:path";
import { DATA_DIR } from "./docker";
import { CAPABILITY_LABELS, MODEL_AGENTS, type EffectiveModel, type FactorySettings, type ModelAgentName, type ModelChoice } from "./factory-agents";
import { createJsonStore } from "./json-store";
import { capabilities, modelRegistry, type GenerativeModel, type ModelRegistry, type RegistrySnapshot } from "./models";

type AgentModelEntry = ModelChoice & { id: ModelAgentName; updatedAt: string };

export type ResolvedModel = EffectiveModel & { generative?: GenerativeModel };

export class InvalidModelChoiceError extends Error {}

/** MOZAIK_MODEL is the model for every agent without a saved setting. */
export const defaultModelName = () => process.env.MOZAIK_MODEL?.trim() || "gpt-5.5";

/** Per-agent provider and model settings, one entry per agent that has one. */
export function createAgentModels(file: string, source: ModelRegistry = modelRegistry) {
  const store = createJsonStore<AgentModelEntry>(file);

  const defaultModel = (registry: RegistrySnapshot): ResolvedModel => {
    const model = defaultModelName();
    const found = registry.findByName(model);
    return { provider: found?.provider, model, source: "env", supported: Boolean(found), generative: found?.model };
  };

  const resolveEntry = (registry: RegistrySnapshot, entry: AgentModelEntry | undefined): ResolvedModel => {
    if (!entry) return defaultModel(registry);
    const generative = registry.find(entry.provider, entry.model);
    return { provider: entry.provider, model: entry.model, source: "settings", supported: Boolean(generative), generative };
  };

  function validate(registry: RegistrySnapshot, agent: ModelAgentName, { provider, model }: ModelChoice) {
    const found = registry.find(provider, model);
    if (!found) return `${agent}: unknown model ${provider}/${model}`;
    const { label, requires } = MODEL_AGENTS.find((a) => a.id === agent)!;
    const missing = requires.filter((c) => !capabilities(found).includes(c));
    if (missing.length) return `${agent}: ${model} doesn't support ${missing.map((c) => CAPABILITY_LABELS[c]).join(" or ")}, which the ${label.toLowerCase()} needs`;
  }

  const strip = ({ provider, model, source, supported }: ResolvedModel): EffectiveModel => ({ provider, model, source, supported });

  return {
    /** Resolved at the start of every agent run, so saved changes apply from the next run on. */
    resolve: async (agent: ModelAgentName) => {
      const [registry, entry] = await Promise.all([source.load(), store.get(agent)]);
      return resolveEntry(registry, entry);
    },

    async view(): Promise<FactorySettings> {
      const [registry, entries] = await Promise.all([source.load(), store.list()]);
      return {
        defaultModel: strip(defaultModel(registry)),
        providers: registry.describe(),
        agents: MODEL_AGENTS.map(({ id }) => {
          const entry = entries.find((e) => e.id === id);
          return { agent: id, ...(entry && { setting: { provider: entry.provider, model: entry.model } }), effective: strip(resolveEntry(registry, entry)) };
        }),
      };
    },

    /** Saves all given agents or none; `null` clears an agent's setting so it falls back to MOZAIK_MODEL. */
    async save(choices: Partial<Record<ModelAgentName, ModelChoice | null>>) {
      const registry = await source.load();
      const errors = Object.entries(choices).flatMap(([agent, choice]) => (choice ? (validate(registry, agent as ModelAgentName, choice) ?? []) : []));
      if (errors.length) throw new InvalidModelChoiceError(errors.join("; "));
      for (const [agent, choice] of Object.entries(choices) as [ModelAgentName, ModelChoice | null][]) {
        if (choice) await store.upsert({ id: agent, provider: choice.provider, model: choice.model, updatedAt: new Date().toISOString() });
        else await store.remove(agent);
      }
    },
  };
}

export const agentModels = createAgentModels(path.join(DATA_DIR, "agent-models.json"));
