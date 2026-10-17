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
  available?: boolean;
};
export type SyneliaModelList = { models: SyneliaModelOption[]; defaultModel: string | null };

export function resolveModel(
  picked: string | undefined,
  list: SyneliaModelList | undefined,
): { provider?: string; model?: string } {
  if (!list) return {};
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
      cached = { at: Date.now(), list: (await response.json()) as SyneliaModelList };
      return cached.list;
    } catch {
      return cached?.list;
    }
  };
}
