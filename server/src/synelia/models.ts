/**
 * Synelia fork: the model a run really used, decided server-side with the same rule as the Mastra
 * factory (`resolveSyneliaModel`): the browser's pick only if it is in the allowlist AND its
 * provider is available, otherwise the deployment default. The browser's header is never stored as
 * is. The list is Mastra's own (`/synelia/models`), cached for a minute.
 */
export type SyneliaModelOption = {
  id: string;
  provider: string;
  model: string;
  /** Display label ('Rapide', 'Approfondi'): what the picker and the reply footer show. */
  label?: string;
  available?: boolean;
  hidden?: boolean;
};
export type SyneliaModelList = {
  models: SyneliaModelOption[];
  defaultModel: string | null;
};

export function resolveModel(
  picked: string | undefined,
  list: SyneliaModelList | undefined,
): { provider?: string; model?: string } {
  // Synelia fork: the list unreachable at save time (Mastra slow) must not leave the run without a
  // model. Fall back to the allowlisted id the browser picked (`provider:model`); the default is
  // unknown here, so nothing is invented when nothing was picked.
  if (!list) return splitModelId(picked);
  const usable = list.models.filter((option) => option.available !== false);
  const option =
    usable.find((candidate) => candidate.id === picked) ??
    usable.find((candidate) => candidate.id === list.defaultModel);
  return option ? { provider: option.provider, model: option.model } : {};
}

let cached: { at: number; list: SyneliaModelList } | undefined;

export function createModelListSource(
  endpoint: string | URL | undefined,
  token: string | undefined,
): () => Promise<SyneliaModelList | undefined> {
  return async () => {
    if (!endpoint || !token) return undefined;
    if (cached && Date.now() - cached.at < 60_000) return cached.list;
    try {
      const response = await fetch(new URL("/synelia/models", endpoint), {
        headers: { "x-openbot-agent-token": token },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return cached?.list;
      cached = {
        at: Date.now(),
        list: (await response.json()) as SyneliaModelList,
      };
      return cached.list;
    } catch {
      return cached?.list;
    }
  };
}

/** Hidden (QA) options are for administrators only. */
export function visibleModels(
  list: SyneliaModelList,
  admin: boolean,
): SyneliaModelList {
  return admin
    ? list
    : { ...list, models: list.models.filter((option) => !option.hidden) };
}

/**
 * Fail CLOSED: an id in the QA namespace (`synelia-test:*`) counts as hidden even when the list is
 * unreachable and nothing is cached, so a non-admin can never reach the failing model.
 */
export function isHiddenModel(
  picked: string | undefined,
  list: SyneliaModelList | undefined,
): boolean {
  if (!picked) return false;
  if (picked.startsWith("synelia-test:")) return true;
  return Boolean(
    list?.models.some((option) => option.id === picked && option.hidden),
  );
}

/** The display label of a stored provider/model pair (badge map, reply footer). */
export function labelFor(
  entry: { provider?: string | null; model?: string | null },
  list: SyneliaModelList | undefined,
): string | undefined {
  return list?.models.find(
    (option) =>
      option.provider === entry.provider && option.model === entry.model,
  )?.label;
}

/** `router9:gemini/gemini-3.8-flash` -> { provider: "router9", model: "gemini/gemini-3.8-flash" }. */
export function splitModelId(id: string | undefined): {
  provider?: string;
  model?: string;
} {
  const colon = id?.indexOf(":") ?? -1;
  if (!id || colon <= 0 || colon === id.length - 1) return {};
  return { provider: id.slice(0, colon), model: id.slice(colon + 1) };
}
