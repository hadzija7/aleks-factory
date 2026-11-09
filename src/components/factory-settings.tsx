"use client";

import { useEffect, useState, type FormEvent } from "react";
import { CAPABILITY_LABELS, FACTORY_AGENTS, MODEL_AGENTS, type FactorySettings as Settings, type ModelAgentName, type ModelChoice, type ProviderInfo } from "@/lib/factory-agents";

type Draft = Partial<Record<ModelAgentName, ModelChoice | null>>;

const draftFrom = (settings: Settings): Draft => Object.fromEntries(settings.agents.map((a) => [a.agent, a.setting ?? null]));

const sameChoice = (a: ModelChoice | null | undefined, b: ModelChoice | null | undefined) => a?.provider === b?.provider && a?.model === b?.model;

const selectClass = "rounded-md border border-black/10 bg-transparent px-3 py-2 dark:border-white/15 dark:bg-background";

/** Per-agent provider and model, saved to the server; agents without a setting use MOZAIK_MODEL. */
export function FactorySettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (next: Settings) => {
    setSettings(next);
    setDraft(draftFrom(next));
  };

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then(async (res) => (res.ok ? apply(await res.json()) : setError((await res.json().catch(() => null))?.error ?? res.statusText)))
      .catch((e: Error) => setError(e.message));
  }, []);

  if (!settings) return error ? <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p> : <p className="text-sm opacity-60">Loading…</p>;

  const persisted = draftFrom(settings);
  const dirty = MODEL_AGENTS.some(({ id }) => !sameChoice(draft[id], persisted[id]));

  const update = (agent: ModelAgentName, choice: ModelChoice | null) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [agent]: choice }));
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const res = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agents: draft }) });
    setSaving(false);
    if (!res.ok) return setError((await res.json().catch(() => null))?.error ?? res.statusText);
    apply(await res.json());
    setSaved(true);
  };

  const { defaultModel, providers } = settings;
  const defaultLabel = `Default: ${defaultModel.model}${defaultModel.provider ? ` (${providerLabel(providers, defaultModel.provider)})` : ""}`;

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <p className="text-sm opacity-70">
        Each agent runs on its own provider and model. Agents set to the default use <code className="rounded bg-black/5 px-1 dark:bg-white/10">MOZAIK_MODEL</code> (
        <code>{defaultModel.model}</code>
        {!defaultModel.supported && <span className="text-red-600"> — not a supported model</span>}). Changes apply from each agent&apos;s next run.
      </p>

      {FACTORY_AGENTS.map((agent) => {
        if (agent.requires === null)
          return (
            <section key={agent.id} className="flex flex-col gap-1 rounded-xl border border-dashed border-black/10 p-5 dark:border-white/15">
              <h2 className="font-semibold">{agent.label}</h2>
              <p className="text-sm opacity-60">{agent.description}</p>
            </section>
          );
        const choice = draft[agent.id] ?? null;
        const view = settings.agents.find((a) => a.agent === agent.id);
        const provider = choice ? providers.find((p) => p.id === choice.provider) : undefined;
        const firstUsable = (p: ProviderInfo) => p.models.find((m) => agent.requires.every((c) => m.capabilities.includes(c)));
        return (
          <section key={agent.id} className="flex flex-col gap-3 rounded-xl border border-black/10 p-5 dark:border-white/15">
            <div>
              <h2 className="font-semibold">{agent.label}</h2>
              <p className="text-sm opacity-60">{agent.description}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span className="opacity-70">Provider</span>
                <select
                  aria-label={`${agent.label} provider`}
                  value={choice?.provider ?? ""}
                  onChange={(e) => {
                    const next = providers.find((p) => p.id === e.target.value);
                    const model = next && firstUsable(next);
                    update(agent.id, next && model ? { provider: next.id, model: model.name } : null);
                  }}
                  className={selectClass}
                >
                  <option value="">{defaultLabel}</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id} disabled={!firstUsable(p)}>
                      {p.label}
                      {firstUsable(p) ? "" : " (no compatible models)"}
                    </option>
                  ))}
                  {choice && !provider && <option value={choice.provider}>{choice.provider} (unsupported)</option>}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="opacity-70">Model</span>
                <select
                  aria-label={`${agent.label} model`}
                  value={choice?.model ?? ""}
                  disabled={!choice}
                  onChange={(e) => choice && update(agent.id, { provider: choice.provider, model: e.target.value })}
                  className={`${selectClass} disabled:opacity-50`}
                >
                  {!choice && <option value="">{defaultModel.model}</option>}
                  {provider?.models.map((m) => {
                    const missing = agent.requires.filter((c) => !m.capabilities.includes(c));
                    return (
                      <option key={m.name} value={m.name} disabled={missing.length > 0}>
                        {m.name}
                        {missing.length
                          ? ` (no ${missing.map((c) => CAPABILITY_LABELS[c]).join(", ")})`
                          : m.contextWindowSize
                            ? ` · ${Math.round(m.contextWindowSize / 1000)}k context`
                            : ""}
                      </option>
                    );
                  })}
                  {choice && !provider?.models.some((m) => m.name === choice.model) && <option value={choice.model}>{choice.model} (unsupported)</option>}
                </select>
              </label>
            </div>
            <ProviderStatus provider={provider ?? (choice ? undefined : providers.find((p) => p.id === defaultModel.provider))} />
            {view && !view.effective.supported && sameChoice(choice, view.setting ?? null) && (
              <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600">
                {view.effective.provider ? `${view.effective.provider}/` : ""}
                {view.effective.model} is not a supported model, so this agent&apos;s runs will fail. Pick another one.
              </p>
            )}
          </section>
        );
      })}

      {error && <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={saving || !dirty} className="rounded-md bg-foreground px-4 py-2 font-medium text-background hover:opacity-90 disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
        {saved && !dirty && <span className="text-sm text-green-600">Saved</span>}
        {dirty && (
          <button type="button" onClick={() => setDraft(persisted)} className="text-sm opacity-60 hover:opacity-100">
            Discard changes
          </button>
        )}
      </div>
    </form>
  );
}

const providerLabel = (providers: ProviderInfo[], id: string) => providers.find((p) => p.id === id)?.label ?? id;

function ProviderStatus({ provider }: { provider?: ProviderInfo }) {
  if (!provider) return null;
  return (
    <p className="text-xs opacity-70">
      Credential <code className="rounded bg-black/5 px-1 dark:bg-white/10">{provider.credentialEnv}</code>{" "}
      {provider.credentialSet ? <span className="text-green-600">is set</span> : <span className="text-amber-600">is not set on the server</span>}
      {provider.note && <span className="mt-1 block opacity-80">{provider.note}</span>}
    </p>
  );
}
