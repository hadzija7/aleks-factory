import { Cursor, type ModelListItem, type ModelSelection } from "@cursor/sdk";
import type { GenerativeModel, ModelProvider } from "../models";
import { CURSOR_CREDENTIAL_ENV, cursorModel } from "./cursor";

/**
 * The Cursor provider's models come from the account's catalog (`Cursor.models.list()` with CURSOR_API_KEY), cached per
 * process. Without a key, or if the catalog can't be loaded, the provider lists only the configured default and Composer,
 * marked unverified, so the picker is never empty.
 */

/**
 * Assumed id of Grok 4.7, used only when the catalog can't be loaded (with a catalog, the default is matched by id or
 * display name, so "grok-4-7" or "Grok 4.7" resolve too). Cursor publishes no SDK id for it; this follows the dotted
 * version style of Cursor's documented ids (`composer-2.5`). Override with CURSOR_DEFAULT_MODEL.
 */
export const ASSUMED_GROK_MODEL = "grok-4.7";
export const COMPOSER_MODEL = "composer-2.5";

const CATALOG_TTL_MS = 10 * 60_000;
const FAILURE_TTL_MS = 60_000;
const LIST_TIMEOUT_MS = 10_000;

const PROVIDER = { id: "cursor", label: "Cursor", credentialEnv: CURSOR_CREDENTIAL_ENV } as const;
const BASE_NOTE = "Cursor runs the tool loop itself, so tool calls show up in Dash0 traces but not in the task activity feed.";

export const defaultCursorModel = () => process.env.CURSOR_DEFAULT_MODEL?.trim() || ASSUMED_GROK_MODEL;

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The catalog entry for `wanted`: an exact id or alias, else one whose id, alias or display name has the same letters and
 * digits ("grok-4.7" ~ "grok-4-7" ~ "Grok 4.7"), else the shortest id that starts with them.
 */
export function findCatalogModel(models: ModelListItem[], wanted: string) {
  const exact = models.find((m) => m.id === wanted || m.aliases?.includes(wanted));
  if (exact) return exact;
  const key = normalize(wanted);
  if (!key) return undefined;
  const names = (m: ModelListItem) => [m.id, m.displayName, ...(m.aliases ?? [])].map(normalize);
  return (
    models.find((m) => names(m).includes(key)) ??
    models.filter((m) => names(m).some((n) => n.startsWith(key))).sort((a, b) => a.id.length - b.id.length)[0]
  );
}

/**
 * The selection a run sends for a catalog model. Parameterized models get explicit params (otherwise the server silently
 * uses each parameter's first value): the default preset variant that doesn't need Max Mode, else each parameter's first value.
 */
export function selectionFor(model: ModelListItem): ModelSelection {
  const variants = model.variants ?? [];
  const variant = variants.find((v) => v.isDefault && !v.isMaxMode) ?? variants.find((v) => !v.isMaxMode) ?? variants[0];
  if (variant?.params.length) return { id: model.id, params: variant.params };
  const params = (model.parameters ?? []).flatMap((p) => (p.values[0] ? [{ id: p.id, value: p.values[0].value }] : []));
  return params.length ? { id: model.id, params } : { id: model.id };
}

export type CatalogResult =
  | { source: "catalog"; models: ModelListItem[] }
  /** The last catalog this key loaded, kept while a refresh fails. */
  | { source: "stale"; models: ModelListItem[]; reason: string }
  | { source: "fallback"; reason: string };

export type CatalogOptions = {
  list?: (apiKey: string) => Promise<ModelListItem[]>;
  now?: () => number;
  ttlMs?: number;
  failureTtlMs?: number;
  timeoutMs?: number;
};

const redact = (text: string, secret: string) => text.split(secret).join("[redacted]");

function withTimeout<T>(promise: Promise<T>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Loads the catalog for the current CURSOR_API_KEY, cached per key: successes for `ttlMs`, failures for `failureTtlMs`. */
export function createCursorCatalog({
  list = (apiKey) => Cursor.models.list({ apiKey }),
  now = Date.now,
  ttlMs = CATALOG_TTL_MS,
  failureTtlMs = FAILURE_TTL_MS,
  timeoutMs = LIST_TIMEOUT_MS,
}: CatalogOptions = {}) {
  let cached: { key: string; at: number; result: CatalogResult } | undefined;
  let lastGood: { key: string; models: ModelListItem[] } | undefined;
  let inflight: { key: string; promise: Promise<CatalogResult> } | undefined;

  async function load(key: string): Promise<CatalogResult> {
    try {
      const models = await withTimeout(list(key), timeoutMs);
      lastGood = { key, models };
      return { source: "catalog", models };
    } catch (error) {
      const reason = redact(error instanceof Error ? error.message : String(error), key);
      console.warn(`[cursor] couldn't load the model catalog: ${reason}`);
      return lastGood?.key === key ? { source: "stale", models: lastGood.models, reason } : { source: "fallback", reason };
    }
  }

  return {
    async get(): Promise<CatalogResult> {
      const key = process.env[CURSOR_CREDENTIAL_ENV]?.trim();
      if (!key) return { source: "fallback", reason: `${CURSOR_CREDENTIAL_ENV} is not set` };
      if (cached?.key === key && now() - cached.at < (cached.result.source === "catalog" ? ttlMs : failureTtlMs)) return cached.result;
      if (inflight?.key === key) return inflight.promise;
      const promise = load(key).then((result) => {
        cached = { key, at: now(), result };
        return result;
      });
      inflight = { key, promise };
      return promise.finally(() => {
        if (inflight?.promise === promise) inflight = undefined;
      });
    },
  };
}

const models = new Map<string, GenerativeModel>();

/** One Mozaik model per selection, reused across catalog refreshes so lookups stay stable. */
function modelFor(selection: ModelSelection) {
  const key = JSON.stringify(selection);
  let model = models.get(key);
  if (!model) models.set(key, (model = cursorModel(selection)));
  return model;
}

/** The Cursor provider as the registry lists it right now. */
export async function cursorProvider(catalog = cursorCatalog): Promise<ModelProvider> {
  const result = await catalog.get();
  const wanted = defaultCursorModel();
  if (result.source === "fallback") {
    const known = [...new Set([wanted, COMPOSER_MODEL])];
    return {
      ...PROVIDER,
      models: known.map((id) => modelFor({ id })),
      defaultModel: wanted,
      unverifiedModels: known,
      note: `Couldn't load this account's model catalog (${result.reason}), so only known models are listed, unverified. ${BASE_NOTE}`,
    };
  }
  const found = findCatalogModel(result.models, wanted);
  return {
    ...PROVIDER,
    models: result.models.map((m) => modelFor(selectionFor(m))),
    modelLabels: Object.fromEntries(result.models.map((m) => [m.id, m.displayName])),
    defaultModel: found?.id,
    note: [
      ...(found ? [] : [`The default model ${wanted} isn't in this account's catalog.`]),
      ...(result.source === "stale" ? [`Showing the last loaded catalog; refreshing failed (${result.reason}).`] : []),
      BASE_NOTE,
    ].join(" "),
  };
}

export const cursorCatalog = createCursorCatalog();
