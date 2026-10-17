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
  /** Display label from the server ('Rapide', 'Approfondi'); shown instead of raw ids. */
  label?: string;
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
    // With server labels there is no provider grouping (no provider name on screen).
    const group = model.label ? "" : model.providerLabel;
    groups.set(group, [...(groups.get(group) ?? []), model]);
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
      {[...groups.entries()].map(([label, entries]) => {
        const options = entries.map((model) => (
          <option key={model.id} value={model.id}>
            {`${model.label ?? `${model.model} · ${model.usage}`}${model.id === data?.defaultModel ? ` (${ui.model.default})` : ""}`}
          </option>
        ));
        return label ? (
          <optgroup key={label} label={label}>
            {options}
          </optgroup>
        ) : (
          options
        );
      })}
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
  label,
}: {
  provider: string | null;
  model: string;
  label?: string;
}) {
  const text = label ?? `${providerName(provider)} · ${model}`;
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
        { provider: string | null; model: string; label?: string }
      >;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Under an assistant message in OpenBot's own transcript: shown only on the last one of a run. */
export function MessageModelLabel({ messageId }: { messageId: string }) {
  const { data } = useThreadModels();
  const entry = data?.[messageId];
  return entry ? (
    <Badge label={entry.label} model={entry.model} provider={entry.provider} />
  ) : null;
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
        label?: string;
      };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data?.model ? (
    <Badge label={data.label} model={data.model} provider={data.provider} />
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
        lostRunId?: string | null;
        interrupted?: boolean;
      };
    },
    staleTime: 30_000,
    // While a run is still being written, look again every 3 s until it ends.
    refetchInterval: (query) => (query.state.data?.activeRunId ? 3_000 : false),
  });
  return threadStatusView(data, endsOnUserMessage);
}

export type ThreadStatusBody = {
  lastError?: { message?: string | null } | null;
  activeRunId?: string | null;
  lostRunId?: string | null;
  interrupted?: boolean;
} | null;

/**
 * What the page draws from `GET /api/threads/:id`. `activeRunId` and `lostRunId` are ALWAYS
 * exposed: after F5 mid-run the replay restores the partial answer, so the last message is the
 * Bot's, and gating on it hid the running turn (2a). Only the stored error and the "no answer"
 * fallback depend on the person having spoken last.
 */
export function threadStatusView(
  data: ThreadStatusBody | undefined,
  endsOnUserMessage: boolean,
): { error: string | null; activeRunId: string | null; interrupted: boolean } {
  const activeRunId = data?.activeRunId ?? null;
  return {
    error: endsOnUserMessage ? (data?.lastError?.message ?? null) : null,
    activeRunId,
    // Only a run the server KNOWS was lost (lock expired, run never stored). An idle thread, or
    // one whose last message is the person's for any other reason, is never "interrupted".
    interrupted: !activeRunId && Boolean(data?.lostRunId),
  };
}

/**
 * Synelia fork (2a): one step of "a run is going on the server that this page is not streaming".
 * `indicator`: draw Thinking + Stop. `replay`: the run just ended, replay the thread once so the
 * full answer replaces the partial one restored at load.
 */
export function serverRunStep(
  sawActive: boolean,
  activeRunId: string | null,
  localRunning: boolean,
): { sawActive: boolean; indicator: boolean; replay: boolean } {
  if (activeRunId)
    return { sawActive: true, indicator: !localRunning, replay: false };
  if (sawActive && !localRunning)
    return { sawActive: false, indicator: false, replay: true };
  return { sawActive, indicator: false, replay: false };
}
