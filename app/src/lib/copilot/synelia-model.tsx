/**
 * Synelia fork: which model the Mastra Bot answers with.
 *
 * The list comes from the server (`/api/synelia/models`, itself asked of the Mastra server, whose
 * allowlist is the one enforced), never from this file. The choice is kept per browser in
 * localStorage and sent with every run as the AG-UI context entry "Synelia model" with the value
 * `provider:model`; Mastra picks the model from it and the server records it on the run.
 */
import { useAgentContext } from "@copilotkit/react-core/v2";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { client } from "@/lib/client";
import { ui } from "@/lib/i18n";

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
        await client("/api/synelia/models", {
          fallback: ui.model.loadFailed,
        })
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
export function SyneliaModelPicker({
  startOnDefault = false,
}: {
  startOnDefault?: boolean;
} = {}) {
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
    groups.set(model.providerLabel, [
      ...(groups.get(model.providerLabel) ?? []),
      model,
    ]);
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

const providerName = (provider: string | null) =>
  provider === "router9"
    ? "9router"
    : provider === "openrouter"
      ? "OpenRouter"
      : (provider ?? "");

function Badge({
  provider,
  model,
}: {
  provider: string | null;
  model: string;
}) {
  const text = `${providerName(provider)} · ${model}`;
  return (
    <div
      className="mt-1 text-xs text-muted-foreground"
      data-testid="synelia-run-model"
    >
      <span className="sr-only">{`${ui.model.label} : `}</span>
      {text}
    </div>
  );
}

/**
 * The conversation a transcript shows, and whether a run is in flight. Provided by channel-chat.
 * The badge map is ONE owner-checked read per thread (`/api/synelia/threads/:id/models`), disabled
 * while a run streams, and refreshed when the run ends (RUN_FINISHED / RUN_ERROR → not running).
 * No per-message polling.
 */
type ThreadModelsState = { threadId?: string; running: boolean };
const ThreadModelsContext = createContext<ThreadModelsState>({
  running: false,
});

const threadModelsKey = (threadId?: string) => [
  "synelia",
  "thread-models",
  threadId,
];

export function SyneliaThreadModels({
  threadId,
  running,
  children,
}: ThreadModelsState & { children: ReactNode }) {
  const queryClient = useQueryClient();
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running)
      void queryClient.invalidateQueries({
        queryKey: threadModelsKey(threadId),
      });
    wasRunning.current = running;
  }, [running, threadId, queryClient]);
  return (
    <ThreadModelsContext.Provider value={{ threadId, running }}>
      {children}
    </ThreadModelsContext.Provider>
  );
}

function useThreadModels() {
  const { threadId, running } = useContext(ThreadModelsContext);
  return useQuery({
    queryKey: threadModelsKey(threadId),
    enabled: Boolean(threadId) && !running,
    queryFn: async () => {
      const response = await fetch(
        `/api/synelia/threads/${encodeURIComponent(threadId ?? "")}/models`,
        { credentials: "include" },
      );
      if (!response.ok) return {};
      return (await response.json()) as Record<
        string,
        { provider: string | null; model: string }
      >;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Under an assistant message in OpenBot's own transcript: shown only on the last one of a run. */
export function MessageModelLabel({ messageId }: { messageId: string }) {
  const { data } = useThreadModels();
  const entry = data?.[messageId];
  return entry ? <Badge model={entry.model} provider={entry.provider} /> : null;
}

/** Packaged CopilotChat (bot page): one read per finished run, no retry loop. */
function RunModelLabel({ runId }: { runId: string }) {
  const { data } = useQuery({
    queryKey: ["synelia", "answer-model", runId],
    queryFn: async () => {
      const response = await fetch(
        `/api/synelia/runs/${encodeURIComponent(runId)}`,
        {
          credentials: "include",
        },
      );
      if (!response.ok) return null;
      return (await response.json()) as {
        provider: string | null;
        model: string | null;
      };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data?.model ? (
    <Badge model={data.model} provider={data.provider} />
  ) : null;
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
): { error: string | null; activeRunId: string | null; interrupted: boolean } {
  const { data } = useQuery({
    queryKey: ["synelia", "thread-error", threadId],
    enabled: Boolean(threadId),
    queryFn: async () => {
      const response = await fetch(
        `/api/threads/${encodeURIComponent(threadId ?? "")}`,
        { credentials: "include" },
      );
      if (!response.ok) return null;
      return (await response.json()) as {
        lastError?: { message?: string | null } | null;
        activeRunId?: string | null;
        interrupted?: boolean;
      };
    },
    staleTime: 30_000,
    // While a run is still being written, look again every 3 s until it ends.
    refetchInterval: (query) => (query.state.data?.activeRunId ? 3_000 : false),
  });
  if (!endsOnUserMessage)
    return { error: null, activeRunId: null, interrupted: false };
  return {
    error: data?.lastError?.message ?? null,
    activeRunId: data?.activeRunId ?? null,
    interrupted: Boolean(data?.interrupted) && !data?.lastError,
  };
}
