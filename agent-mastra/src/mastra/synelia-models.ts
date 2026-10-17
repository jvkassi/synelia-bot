/**
 * Synelia fork: the models this Bot may answer with, and the one factory that builds them.
 *
 * Config, not code. `SYNELIA_MODELS` lists at most a handful of `provider:model@usage` entries, e.g.
 *   SYNELIA_MODELS=router9:gemini/gemini-3.8-flash@rapide,openrouter:z-ai/glm-5.3@raisonnement
 *   SYNELIA_DEFAULT_MODEL=router9:gemini/gemini-3.8-flash
 * Providers (all OpenAI-compatible Chat Completions):
 *   openrouter  enabled by OPENROUTER_API_KEY (OPENROUTER_BASE_URL optional)
 *   router9     enabled by ROUTER9_BASE_URL + ROUTER9_API_KEY (from secrets/router9.env)
 * A provider without its variables is disabled, and its entries are dropped from the list.
 *
 * The browser sends its choice as the AG-UI context entry "Synelia model" (`provider:model`); only
 * an allowlisted id is honoured, anything else answers with the default. Keys never leave here.
 */
import { createOpenAI } from "@ai-sdk/openai";

type Provider = {
  id: string;
  label: string;
  baseURL: string;
  apiKey: string;
  fetch?: typeof fetch;
};

export type ModelOption = {
  id: string;
  provider: string;
  providerLabel: string;
  model: string;
  usage: string;
};

const env = (name: string) => process.env[name]?.trim() || undefined;

function withV1(url: string) {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * OpenRouter: ask for zero-data-retention endpoints that do not train on prompts, per request,
 * through provider preferences. OPENROUTER_PRIVACY=off removes it (free endpoints are not ZDR).
 */
const openrouterFetch: typeof fetch = async (input, init) => {
  if (env("OPENROUTER_PRIVACY") !== "off" && typeof init?.body === "string") {
    try {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      body.provider = {
        ...((body.provider as object | undefined) ?? {}),
        data_collection: "deny",
        zdr: true,
      };
      init = { ...init, body: JSON.stringify(body) };
    } catch {
      // Not JSON: send as is.
    }
  }
  return fetch(input, init);
};
// Bun's fetch carries a `preconnect` property the type wants.
Object.assign(openrouterFetch, { preconnect: () => {} });

export function syneliaProviders(): Map<string, Provider> {
  const providers = new Map<string, Provider>();
  const openrouterKey = env("OPENROUTER_API_KEY");
  if (openrouterKey) {
    providers.set("openrouter", {
      id: "openrouter",
      label: "OpenRouter",
      baseURL: withV1(env("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1"),
      apiKey: openrouterKey,
      fetch: openrouterFetch,
    });
  }
  const router9Url = env("ROUTER9_BASE_URL");
  const router9Key = env("ROUTER9_API_KEY");
  if (router9Url && router9Key) {
    providers.set("router9", {
      id: "router9",
      label: "9router",
      baseURL: withV1(router9Url),
      apiKey: router9Key,
    });
  }
  return providers;
}

export function modelOptions(): ModelOption[] {
  const providers = syneliaProviders();
  return (env("SYNELIA_MODELS") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const [id = "", usage = "général"] = entry.split("@");
      const colon = id.indexOf(":");
      if (colon <= 0) return [];
      const provider = providers.get(id.slice(0, colon));
      if (!provider) return [];
      return [
        {
          id,
          provider: provider.id,
          providerLabel: provider.label,
          model: id.slice(colon + 1),
          usage,
        },
      ];
    });
}

export function defaultModelId(): string | undefined {
  const options = modelOptions();
  const wanted = env("SYNELIA_DEFAULT_MODEL");
  return options.find((option) => option.id === wanted)?.id ?? options[0]?.id;
}

const cache = new Map<string, ReturnType<ReturnType<typeof createOpenAI>["chat"]>>();

/** The single factory: allowlisted `provider:model` → an OpenAI-compatible chat model. */
export function resolveSyneliaModel(picked: string | undefined) {
  const options = modelOptions();
  const option =
    options.find((candidate) => candidate.id === picked) ??
    options.find((candidate) => candidate.id === defaultModelId());
  if (!option) throw new Error("SYNELIA_MODELS lists no model of an enabled provider.");
  const cached = cache.get(option.id);
  console.log(
    JSON.stringify({ type: "synelia-model", provider: option.provider, model: option.model }),
  );
  if (cached) return cached;
  const provider = syneliaProviders().get(option.provider) as Provider;
  const model = createOpenAI({
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    name: provider.id,
    ...(provider.fetch ? { fetch: provider.fetch } : {}),
  }).chat(option.model);
  cache.set(option.id, model);
  return model;
}

/** The "Synelia model" AG-UI context entry of this run, if the browser sent one. */
export function pickedModel(requestContext?: { get(key: string): unknown }): string | undefined {
  const agUi = requestContext?.get("ag-ui") as { context?: unknown } | undefined;
  const entries = Array.isArray(agUi?.context) ? agUi.context : [];
  if (env("SYNELIA_DEBUG_CONTEXT") === "1") {
    console.log(
      JSON.stringify({
        type: "synelia-context",
        descriptions: entries.map((entry: { description?: unknown }) => entry?.description),
      }),
    );
  }
  const entry = entries.find(
    (candidate: { description?: unknown }) => candidate?.description === "Synelia model",
  ) as { value?: unknown } | undefined;
  return typeof entry?.value === "string"
    ? entry.value.replace(/^"|"$/g, "").trim() || undefined
    : undefined;
}
