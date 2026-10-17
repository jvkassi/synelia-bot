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
import { apiFetch } from "@/lib/api-fetch";
import { apiUrl } from "@/lib/api-url";
import { client } from "@/lib/client";
import { codedReason, withRetryable } from "@/lib/copilot/stop-notice";
import { ui } from "@/lib/i18n";

export type SyneliaModel = {
  id: string;
  provider: string;
  providerLabel: string;
  model: string;
  usage: string;
  /** False when the provider's key cannot run models yet; such models are not offered. */
  available?: boolean;
  /**
   * Friendly name chosen server-side (e.g. « Rapide », « Approfondi »). Shown instead of the raw
   * model id wherever it is present; this file never maps ids to names itself.
   */
  label?: string;
};

/** What the answer footer says: the server's label when it has one, else the raw model id. */
export function answerModelText(
  entry: { provider: string | null; model: string; label?: string | null },
  list?: readonly SyneliaModel[],
): string {
  const own = entry.label?.trim();
  if (own) return own;
  const listed = list
    ?.find(
      (option) =>
        option.model === entry.model &&
        (entry.provider === null || option.provider === entry.provider),
    )
    ?.label?.trim();
  return listed || entry.model;
}

/** One picker option: the label alone when the server named the model, else id · usage as before. */
export function modelOptionText(model: SyneliaModel, isDefault: boolean) {
  const suffix = isDefault ? ` (${ui.model.default})` : "";
  const label = model.label?.trim();
  return label
    ? `${label}${suffix}`
    : `${model.model} · ${model.usage}${suffix}`;
}

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
  // Grouped by provider only while some model has no label: once the server names every model,
  // the provider is not shown at all.
  const named = models.every((model) => Boolean(model.label?.trim()));
  const groups = new Map<string, SyneliaModel[]>();
  for (const model of models) {
    groups.set(model.providerLabel, [
      ...(groups.get(model.providerLabel) ?? []),
      model,
    ]);
  }
  const option = (model: SyneliaModel) => (
    <option key={model.id} value={model.id}>
      {modelOptionText(model, model.id === data?.defaultModel)}
    </option>
  );
  return (
    <select
      aria-label={ui.model.label}
      className="h-8 rounded-md border bg-background px-2 text-sm"
      data-testid="synelia-model-picker"
      onChange={(event) => storeModel(event.target.value)}
      title={ui.model.title}
      value={selected ?? ""}
    >
      {named
        ? models.map(option)
        : [...groups.entries()].map(([label, entries]) => (
            <optgroup key={label} label={label}>
              {entries.map(option)}
            </optgroup>
          ))}
    </select>
  );
}

/** Under an answer: the model's label, or its raw id. No provider prefix (« 9router · … »). */
export function Badge(entry: {
  provider: string | null;
  model: string;
  label?: string | null;
}) {
  const { data } = useModelList();
  const text = answerModelText(entry, data?.models);
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

/** Second read of the badge map after a run ends, once the server has stored it. */
export const THREAD_MODELS_SETTLE_MS = 2_000;

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
    if (wasRunning.current && !running) {
      const refresh = () =>
        void queryClient.invalidateQueries({
          queryKey: threadModelsKey(threadId),
        });
      refresh();
      // The server stores the run (and its model) AFTER the stream ends, asynchronously
      // (postgres-runner.ts `persist`): a read right at the end can miss it. Asked once more.
      const again = setTimeout(refresh, THREAD_MODELS_SETTLE_MS);
      wasRunning.current = running;
      return () => clearTimeout(again);
    }
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
      const response = await apiFetch(
        apiUrl(
          `/api/synelia/threads/${encodeURIComponent(threadId ?? "")}/models`,
        ),
        { credentials: "include" },
      );
      // Thrown, not `{}`: an empty map cached with an infinite staleTime hid every label of the
      // thread until the next run ended (e.g. a reload that met a transient error).
      if (!response.ok)
        throw Object.assign(new Error("thread models"), {
          status: response.status,
        });
      return (await response.json()) as Record<
        string,
        { provider: string | null; model: string; label?: string | null }
      >;
    },
    // A successful map stays until a run ends; a failed read is asked again on the next mount.
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
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
      const response = await apiFetch(
        apiUrl(`/api/synelia/runs/${encodeURIComponent(runId)}`),
        {
          credentials: "include",
        },
      );
      if (!response.ok) return null;
      return (await response.json()) as {
        provider: string | null;
        model: string | null;
        label?: string | null;
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
): {
  error: string | null;
  activeRunId: string | null;
  interrupted: boolean;
  known: boolean | undefined;
} {
  const { data } = useQuery({
    queryKey: ["synelia", "thread-error", threadId],
    enabled: Boolean(threadId),
    queryFn: async () => {
      const response = await apiFetch(
        apiUrl(`/api/threads/${encodeURIComponent(threadId ?? "")}`),
        { credentials: "include" },
      );
      if (!response.ok) return { known: false } as ThreadStatusBody;
      return (await response.json()) as {
        known?: boolean;
        lastError?: {
          message?: string | null;
          code?: string | null;
          retryable?: boolean | null;
        } | null;
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
  /** Synelia fork: `false` when the server has no such thread/run; absent on older servers. */
  known?: boolean;
  /** `code`: a stable server code (stop-notice.ts), read before the message when present. */
  /** `retryable: false`: the failed run had a side-effect tool, no « Réessayer » (stop-notice.ts). */
  lastError?: {
    message?: string | null;
    code?: string | null;
    retryable?: boolean | null;
  } | null;
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
): {
  error: string | null;
  activeRunId: string | null;
  interrupted: boolean;
  known: boolean | undefined;
} {
  const activeRunId = data?.activeRunId ?? null;
  return {
    // `undefined` while loading (no data yet); the server's `known`, or — on an older server that
    // omits it — true whenever the thread status came back at all (a 404 set `{ known: false }`).
    known:
      data === undefined
        ? undefined
        : typeof data.known === "boolean"
          ? data.known
          : true,
    error: endsOnUserMessage
      ? withRetryable(
          codedReason(data?.lastError?.code, data?.lastError?.message),
          data?.lastError?.retryable,
        )
      : null,
    activeRunId,
    // Only a run the server KNOWS was lost (lock expired, run never stored). An idle thread, or
    // one whose last message is the person's for any other reason, is never "interrupted".
    interrupted: !activeRunId && Boolean(data?.lostRunId),
  };
}

/**
 * Synelia fork: whether « Réponse interrompue » (a lost run) may be drawn. Never while this tab has a
 * turn of its own in flight, including the gap between send and RUN_STARTED (`turnsInFlight` > 0
 * while `agent.isRunning` is still false), nor once this page has sent a turn.
 */
export function showInterrupted(state: {
  interrupted: boolean;
  localRunning: boolean;
  sentHere: boolean;
  turnsInFlight: number;
}): boolean {
  return (
    state.interrupted &&
    !state.localRunning &&
    !state.sentHere &&
    state.turnsInFlight === 0
  );
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
