/**
 * Synelia fork: the models this Bot may answer with, and the one factory that builds them.
 *
 * Config, not code. `SYNELIA_MODELS` lists at most a handful of `provider:model@usage` entries, e.g.
 *   SYNELIA_MODELS=router9:cc/claude-sonnet-5-5@rapide,router9:gemini/gemini-3.8-flash@reflexion
 *   SYNELIA_DEFAULT_MODEL=router9:cc/claude-sonnet-5-5
 * Providers (all OpenAI-compatible Chat Completions):
 *   openrouter  enabled by OPENROUTER_API_KEY (OPENROUTER_BASE_URL optional)
 *   router9     enabled by ROUTER9_BASE_URL + ROUTER9_API_KEY (from secrets/router9.env)
 * A provider without its variables is disabled, and its entries are dropped from the list.
 *
 * The browser sends its choice as the AG-UI context entry "Synelia model" (`provider:model`); only
 * an allowlisted id is honoured, anything else answers with the default. Keys never leave here.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createOpenAI } from "@ai-sdk/openai";

/** Synelia fork (timing): performance.now() when the agent request reached this server. */
export const agentRequestArrival = new AsyncLocalStorage<number>();

/**
 * Synelia fork: logs `synelia_timing {kind:"provider_call",...}` per outbound model call, numbers
 * only (never the body): since the agent request arrived (agent build, memory, tool schemas),
 * response headers (TTFB) and first body chunk.
 */
export function timedFetch(
  providerId: string,
  inner: typeof fetch,
): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    const arrived = agentRequestArrival.getStore();
    const start = performance.now();
    const requestBytes =
      typeof init?.body === "string" ? init.body.length : undefined;
    const log = (extra: Record<string, number | string | undefined>) =>
      console.log(
        `synelia_timing ${JSON.stringify({
          kind: "provider_call",
          provider: providerId,
          requestBytes,
          sinceAgentRequestMs:
            arrived === undefined ? undefined : Math.round(start - arrived),
          ...extra,
        })}`,
      );
    const response = await inner(input, init);
    const headersMs = Math.round(performance.now() - start);
    if (!response.body) {
      log({ status: response.status, headersMs });
      return response;
    }
    let first = true;
    const body = response.body.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (first) {
            first = false;
            log({
              status: response.status,
              headersMs,
              firstChunkMs: Math.round(performance.now() - start),
            });
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return wrapped as typeof fetch;
}

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
  /** Display label for the picker and the reply footer: no provider name, no raw id. */
  label: string;
  /** False when the provider's key cannot run models (e.g. an OpenRouter management key). */
  available: boolean;
  /** QA-only entry: the server shows it to administrators only and refuses it for anybody else. */
  hidden?: boolean;
};

/**
 * QA model, enabled by SYNELIA_TEST_MODEL=on: every call answers HTTP 401 with a provider-style
 * body, so the error path (RUN_ERROR, French notice, stored technical text) can be exercised on
 * demand without breaking a real provider. Admin-only (see server/src/persistence/postgres-runner.ts).
 */
export const TEST_MODEL_ID = "synelia-test:always-fails";
const failingFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({ error: { message: "Synelia test model: always fails." } }),
    {
      status: 401,
      headers: { "content-type": "application/json" },
    },
  );
Object.assign(failingFetch, { preconnect: () => {} });

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
      baseURL: withV1(
        env("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1",
      ),
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

/**
 * Extra Chat Completions fields per model. Gemini Flash ('Réflexion') thinks before its first token,
 * and 9router only answers once that token exists: `reasoning_effort: "low"` cut it from ~3.6 s to
 * ~1.5 s on a generative prompt (curl on konnect, 2026-10-17). "minimal"/"none" answer 400.
 */
export function requestExtras(
  provider: string,
  model: string,
): Record<string, unknown> {
  return provider === "router9" && /gemini.*flash/i.test(model)
    ? { reasoning_effort: "low" }
    : {};
}

/** Merges `extras` into a JSON request body (never overrides a field the SDK already set). */
export function withRequestExtras(
  inner: typeof fetch,
  extras: Record<string, unknown>,
): typeof fetch {
  if (Object.keys(extras).length === 0) return inner;
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      try {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        init = { ...init, body: JSON.stringify({ ...extras, ...body }) };
      } catch {}
    }
    return inner(input, init);
  };
  return wrapped as typeof fetch;
}

/**
 * 'Rapide' for Claude Sonnet (first content token ~0.7-2 s through 9router), 'Réflexion' for Gemini
 * Flash (thinks first, ~1.4-5 s even at reasoning_effort low): measured on konnect with the app's
 * real payload, 2026-10-17. Otherwise the configured usage. Never the provider name.
 */
export function modelLabel(model: string, usage: string): string {
  if (/claude|sonnet/i.test(model)) return "Rapide";
  if (/flash/i.test(model)) return "Réflexion";
  return usage.charAt(0).toUpperCase() + usage.slice(1);
}

export function modelOptions(): ModelOption[] {
  const providers = syneliaProviders();
  const test: ModelOption[] =
    env("SYNELIA_TEST_MODEL") === "on"
      ? [
          {
            id: TEST_MODEL_ID,
            provider: "synelia-test",
            providerLabel: "Test QA",
            model: "always-fails",
            usage: "échec forcé (admin)",
            label: "Test (échec forcé)",
            available: true,
            hidden: true,
          },
        ]
      : [];
  return [...listed(providers), ...test];
}

function listed(providers: Map<string, Provider>): ModelOption[] {
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
          label: modelLabel(id.slice(colon + 1), usage),
          available: availability.get(provider.id) !== false,
        },
      ];
    });
}

/**
 * Whether each provider's key can actually run a model. Probed, never assumed from the key's mere
 * presence: an OpenRouter management/provisioning key is accepted by /key but cannot do inference.
 * Unknown (not probed yet) counts as available. Refreshed at most every 5 minutes.
 */
const availability = new Map<string, boolean>();
let probedAt = 0;

export async function probeProviders(force = false): Promise<void> {
  if (!force && Date.now() - probedAt < 5 * 60_000) return;
  probedAt = Date.now();
  const openrouter = syneliaProviders().get("openrouter");
  if (openrouter) {
    try {
      const response = await fetch(`${openrouter.baseURL}/key`, {
        headers: { Authorization: `Bearer ${openrouter.apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await response.json().catch(() => ({}))) as {
        data?: { is_management_key?: boolean; is_provisioning_key?: boolean };
      };
      availability.set(
        "openrouter",
        response.ok &&
          !body.data?.is_management_key &&
          !body.data?.is_provisioning_key,
      );
    } catch {
      // Network trouble says nothing about the key: keep the last answer.
    }
  }
}

export function defaultModelId(): string | undefined {
  const options = modelOptions().filter(
    (option) => option.available && !option.hidden,
  );
  const wanted = env("SYNELIA_DEFAULT_MODEL");
  return options.find((option) => option.id === wanted)?.id ?? options[0]?.id;
}

const cache = new Map<
  string,
  ReturnType<ReturnType<typeof createOpenAI>["chat"]>
>();

/** The single factory: allowlisted `provider:model` → an OpenAI-compatible chat model. */
export function resolveSyneliaModel(picked: string | undefined) {
  const options = modelOptions();
  const option =
    options.find(
      (candidate) => candidate.id === picked && candidate.available,
    ) ?? options.find((candidate) => candidate.id === defaultModelId());
  if (!option)
    throw new Error("SYNELIA_MODELS lists no model of an enabled provider.");
  const cached = cache.get(option.id);
  console.log(
    JSON.stringify({
      type: "synelia-model",
      provider: option.provider,
      model: option.model,
    }),
  );
  if (cached) return cached;
  const provider =
    option.id === TEST_MODEL_ID
      ? {
          id: "synelia-test",
          label: "Test QA",
          baseURL: "http://synelia-test.invalid/v1",
          apiKey: "none",
          fetch: failingFetch,
        }
      : (syneliaProviders().get(option.provider) as Provider);
  const model = createOpenAI({
    baseURL: provider.baseURL,
    apiKey: provider.apiKey,
    name: provider.id,
    fetch: timedFetch(
      provider.id,
      withRequestExtras(
        provider.fetch ?? fetch,
        requestExtras(option.provider, option.model),
      ),
    ),
  }).chat(option.model);
  cache.set(option.id, model);
  return model;
}

/** The "Synelia model" AG-UI context entry of this run, if the browser sent one. */
export function pickedModel(requestContext?: {
  get(key: string): unknown;
}): string | undefined {
  const agUi = requestContext?.get("ag-ui") as
    | { context?: unknown }
    | undefined;
  const entries = Array.isArray(agUi?.context) ? agUi.context : [];
  if (env("SYNELIA_DEBUG_CONTEXT") === "1") {
    console.log(
      JSON.stringify({
        type: "synelia-context",
        descriptions: entries.map(
          (entry: { description?: unknown }) => entry?.description,
        ),
      }),
    );
  }
  const entry = entries.find(
    (candidate: { description?: unknown }) =>
      candidate?.description === "Synelia model",
  ) as { value?: unknown } | undefined;
  return typeof entry?.value === "string"
    ? entry.value.replace(/^"|"$/g, "").trim() || undefined
    : undefined;
}
