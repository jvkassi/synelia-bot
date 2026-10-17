/**
 * Synelia fork: which model the Mastra Bot answers with.
 *
 * The list comes from the server (`/api/synelia/models`, itself asked of the Mastra server, whose
 * allowlist is the one enforced), never from this file. The choice is kept per browser in
 * localStorage and sent with every run as the AG-UI context entry "Synelia model" with the value
 * `provider:model`; Mastra picks the model from it and the server records it on the run.
 */
import { useAgentContext } from "@copilotkit/react-core/v2";
import { ui } from "@/lib/i18n";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { client } from "@/lib/client";

export type SyneliaModel = {
  id: string;
  provider: string;
  providerLabel: string;
  model: string;
  usage: string;
  /** False when the provider's key cannot run models yet; such models are not offered. */
  available?: boolean;
};

type ModelList = { models: SyneliaModel[]; defaultModel: string | null };

const STORAGE_KEY = "synelia.model";
const CHANGE_EVENT = "synelia-model-change";

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const readStored = () => window.localStorage.getItem(STORAGE_KEY);

function storeModel(id: string) {
  window.localStorage.setItem(STORAGE_KEY, id);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useModelList() {
  return useQuery({
    queryKey: ["synelia", "models"],
    queryFn: async () =>
      (await (
        await client("/api/synelia/models", { fallback: "Could not load models" })
      ).json()) as ModelList,
    // Unavailable providers (e.g. OpenRouter before an inference key) are not offered at all.
    select: (list: ModelList): ModelList => ({
      ...list,
      models: list.models.filter((model) => model.available !== false),
    }),
    staleTime: 5 * 60_000,
  });
}

/** The selected model id, falling back to the deployment default when none or a stale one is kept. */
export function useSyneliaModel(): string | undefined {
  const stored = useSyncExternalStore(subscribe, readStored, () => null);
  const { data } = useModelList();
  const models = data?.models ?? [];
  if (stored && models.some((model) => model.id === stored)) return stored;
  return data?.defaultModel ?? models[0]?.id;
}

/** Sends the choice with every run. Renders nothing. */
export function SyneliaModelContext() {
  const model = useSyneliaModel();
  useAgentContext({ description: "Synelia model", value: model ?? "" });
  return null;
}

/**
 * `startOnDefault`: a new conversation always begins on the deployment default, not on whatever
 * was picked last time; the choice made here then applies to the conversation it starts.
 */
export function SyneliaModelPicker({ startOnDefault = false }: { startOnDefault?: boolean } = {}) {
  useEffect(() => {
    if (!startOnDefault) return;
    window.localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  }, [startOnDefault]);
  const { data } = useModelList();
  const selected = useSyneliaModel();
  const models = data?.models ?? [];
  if (models.length === 0) return null;
  const groups = new Map<string, SyneliaModel[]>();
  for (const model of models) {
    groups.set(model.providerLabel, [...(groups.get(model.providerLabel) ?? []), model]);
  }
  return (
    <select
      aria-label={ui.model.label}
      className="h-8 rounded-md border bg-background px-2 text-sm"
      data-testid="synelia-model-picker"
      onChange={(event) => storeModel(event.target.value)}
      title={ui.model.title}
      value={selected ?? ""}
    >
      {[...groups.entries()].map(([label, entries]) => (
        <optgroup key={label} label={label}>
          {entries.map((model) => (
            <option key={model.id} value={model.id}>
              {`${model.model} · ${model.usage}${model.id === data?.defaultModel ? ` (${ui.model.default})` : ""}`}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * Under the last assistant message of each run: which provider/model answered it.
 *
 * Read from the run record the server keeps (`/api/synelia/runs/:runId`), so it is the same fact the
 * database holds. A run still streaming is not stored yet: the query retries until it is.
 */
function ModelLabel({ path, cacheKey }: { path: string; cacheKey: string }) {
  const { data } = useQuery({
    queryKey: ["synelia", "answer-model", cacheKey],
    queryFn: async () => {
      const response = await fetch(path, { credentials: "include" });
      if (!response.ok) throw new Error("not yet");
      return (await response.json()) as { provider: string | null; model: string | null; status: string };
    },
    retry: 8,
    retryDelay: 2_000,
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (!data?.model) return null;
  const providerLabel =
    data.provider === "router9" ? "9router" : data.provider === "openrouter" ? "OpenRouter" : data.provider;
  return (
    <div className="mt-1 text-xs text-muted-foreground" data-testid="synelia-run-model">
      {`${providerLabel} · ${data.model}`}
    </div>
  );
}

function RunModelLabel({ runId }: { runId: string }) {
  return <ModelLabel cacheKey={`run:${runId}`} path={`/api/synelia/runs/${encodeURIComponent(runId)}`} />;
}

/** Under an assistant message in OpenBot's own transcript (conversation pages). */
export function MessageModelLabel({ messageId }: { messageId: string }) {
  return (
    <ModelLabel
      cacheKey={`message:${messageId}`}
      path={`/api/synelia/messages/${encodeURIComponent(messageId)}/model`}
    />
  );
}

export const syneliaRunModelRenderer = {
  render: ({
    message,
    position,
    runId,
    messageIndexInRun,
    numberOfMessagesInRun,
  }: {
    message: { role: string };
    position: string;
    runId: string;
    messageIndexInRun: number;
    numberOfMessagesInRun: number;
  }) =>
    position === "after" &&
    message.role === "assistant" &&
    runId &&
    messageIndexInRun === numberOfMessagesInRun - 1 ? (
      <RunModelLabel runId={runId} />
    ) : null,
};

/**
 * After a reload: the stored error of the thread's last run (status "error" in synelia_thread_run),
 * read from GET /api/threads/:id under its owner check. Only shown while the conversation still ends
 * on the person's message, i.e. nothing answered after the failure.
 */
export function useStoredRunError(
  threadId: string | undefined,
  endsOnUserMessage: boolean,
): string | null {
  const { data } = useQuery({
    queryKey: ["synelia", "thread-error", threadId],
    enabled: Boolean(threadId),
    queryFn: async () => {
      const response = await fetch(`/api/threads/${encodeURIComponent(threadId ?? "")}`, {
        credentials: "include",
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { lastError?: { message?: string | null } | null };
      return body.lastError?.message ?? null;
    },
    staleTime: 30_000,
  });
  return endsOnUserMessage ? (data ?? null) : null;
}
