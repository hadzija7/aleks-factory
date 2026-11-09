/** The factory's agents and the shapes the settings API shares with the UI. Client-safe: no Mozaik or Node imports. */

export type ModelCapability = "functionCalling" | "structuredOutput";

export const CAPABILITY_LABELS: Record<ModelCapability, string> = { functionCalling: "tool calling", structuredOutput: "structured output" };

export const FACTORY_AGENTS = [
  {
    id: "implement",
    label: "Implementer",
    description: "Task Executor: writes the code for a task, and fixes review findings, merge conflicts and broken checks.",
    requires: ["functionCalling"],
  },
  {
    id: "review",
    label: "Code reviewer",
    description: "Reviews the implementer's changes with read-only tools and returns a structured verdict.",
    requires: ["functionCalling", "structuredOutput"],
  },
  {
    id: "merge",
    label: "Merge",
    description: "Squashes an approved task and merges it into main. Runs git only and never calls a model.",
    requires: null,
  },
] as const satisfies readonly { id: string; label: string; description: string; requires: readonly ModelCapability[] | null }[];

export type AgentName = (typeof FACTORY_AGENTS)[number]["id"];

/** Agents that call a model, so they get a provider and model setting. */
export type ModelAgentName = Extract<(typeof FACTORY_AGENTS)[number], { requires: readonly ModelCapability[] }>["id"];

export const MODEL_AGENTS = FACTORY_AGENTS.filter((agent): agent is Extract<(typeof FACTORY_AGENTS)[number], { id: ModelAgentName }> => agent.requires !== null);

export const isModelAgent = (value: unknown): value is ModelAgentName => MODEL_AGENTS.some((agent) => agent.id === value);

export type ModelChoice = { provider: string; model: string };

/** `contextWindowSize` is absent when the provider doesn't publish it. */
export type ModelInfo = { name: string; contextWindowSize?: number; capabilities: ModelCapability[] };

export type ProviderInfo = {
  id: string;
  label: string;
  /** Env var holding the provider's credential; the API only reports whether it is set. */
  credentialEnv: string;
  credentialSet: boolean;
  note?: string;
  models: ModelInfo[];
};

/** The model an agent runs on: its saved setting, or the MOZAIK_MODEL default. `supported` is false if the registry doesn't know it. */
export type EffectiveModel = { provider?: string; model: string; source: "settings" | "env"; supported: boolean };

export type AgentModelView = { agent: ModelAgentName; setting?: ModelChoice; effective: EffectiveModel };

export type FactorySettings = { defaultModel: EffectiveModel; providers: ProviderInfo[]; agents: AgentModelView[] };
