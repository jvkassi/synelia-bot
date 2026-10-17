/**
 * Synelia phase 0: the open (MIT) CopilotKit runner, made durable in Postgres.
 *
 * Replaces `IntelligenceAgentRunner` (which streams through Intelligence's WebSocket gateway). The
 * runtime runs in plain SSE mode; this runner keeps CopilotKit's own `InMemoryAgentRunner` for the
 * live part (streaming, connect/replay of an in-flight run, stop) and adds:
 *
 *  1. every finished run's compacted AG-UI events, message snapshot and requested provider/model go
 *     to `synelia_thread_run`;
 *  2. a thread not in memory (new process, evicted) is rehydrated from Postgres before `connect`,
 *     `run`, or the thread REST endpoints read it, so a reload or a restart still shows history;
 *  3. owner checks: a thread belongs to the person who first ran it.
 *
 * `listThreads()` is filtered to the requesting person (the in-memory default lists everyone's) and
 * `clearThreads()` is a no-op, because a browser must not be able to wipe durable history.
 */
import type { BaseEvent, Message } from "@ag-ui/client";
import {
  type AgentRunnerConnectRequest,
  type AgentRunnerRunRequest,
  InMemoryAgentRunner,
  ɵGLOBAL_STORE,
} from "@copilotkit/runtime/v2";
import { defer, from, type Observable, of, switchMap } from "rxjs";
import {
  isHiddenModel,
  resolveModel,
  type SyneliaModelList,
} from "../synelia/models";
import { pilotTools } from "../synelia/pilot-gate";
import { logRunTiming } from "../synelia/request-log";
import { adjustPersistedRun, finishClass } from "../synelia/run-refusal";
import type {
  LocalIntelligence,
  LocalThreadSummary,
} from "./local-intelligence";
import { requestUser } from "./request-user";

type HistoricRun = {
  runId: string;
  events: BaseEvent[];
  parentRunId?: string | null;
  createdAt?: number;
};
type GlobalStore = {
  peek(
    threadId: string,
  ): { historicRuns: HistoricRun[]; messagesSnapshot: Message[] } | undefined;
  getOrCreate(threadId: string): unknown;
  appendRun(threadId: string, run: unknown): void;
};

const notFound = () =>
  Object.assign(new Error("Thread not found."), { status: 404 });

export const isThreadAlreadyRunning = (error: unknown) =>
  error instanceof Error && error.message === "Thread already running";

/** What a refused concurrent run streams: the same reason/code as the 409 lock path. */
export function threadBusyEvents(request: AgentRunnerRunRequest): BaseEvent[] {
  return [
    {
      type: "RUN_STARTED",
      threadId: request.threadId,
      runId: request.input.runId,
    } as BaseEvent,
    {
      type: "RUN_ERROR",
      threadId: request.threadId,
      runId: request.input.runId,
      message: "Thread is busy.",
      code: "thread_busy",
    } as BaseEvent,
  ];
}

export class PostgresAgentRunner extends InMemoryAgentRunner {
  readonly #store: LocalIntelligence;
  readonly #hydrated = new Map<string, Promise<void>>();
  /** Thread index mirrored in memory, because the runtime's listThreads() is synchronous. */
  readonly #index = new Map<string, LocalThreadSummary>();
  readonly #global = ɵGLOBAL_STORE as unknown as GlobalStore;

  readonly #models: () => Promise<SyneliaModelList | undefined>;

  constructor(
    store: LocalIntelligence,
    models: () => Promise<SyneliaModelList | undefined> = async () => undefined,
  ) {
    super({ maxThreads: 500, maxRunsPerThread: 200 });
    this.#store = store;
    this.#models = models;
    // Rename / archive / delete / title: the index follows at once, not at the next run's end.
    store.onThreadChange((change) => this.applyThreadChange(change));
  }

  applyThreadChange(
    change:
      | { kind: "updated"; thread: LocalThreadSummary }
      | { kind: "deleted"; threadId: string },
  ): void {
    if (change.kind === "deleted") this.#index.delete(change.threadId);
    else this.#index.set(change.thread.id, change.thread);
  }

  /** For tests and the thread mutation route. */
  indexed(threadId: string): LocalThreadSummary | undefined {
    return this.#index.get(threadId);
  }

  /** Load the thread index at boot. Failure is logged, not fatal: the index fills as people talk. */
  async warm(): Promise<void> {
    try {
      for (const thread of await this.#store.listAllThreads())
        this.#index.set(thread.id, thread);
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "synelia-runner-warm-failed",
          reason: String(error),
        }),
      );
    }
  }

  /** Make sure a thread's history is in memory. Idempotent and concurrent-safe per thread. */
  hydrate(threadId: string): Promise<void> {
    const existing = this.#hydrated.get(threadId);
    if (existing) return existing;
    const loading = (async () => {
      const inMemory = this.#global.peek(threadId);
      if (inMemory && inMemory.historicRuns.length > 0) return;
      const runs = await this.#store.loadRuns(threadId);
      if (runs.length === 0) return;
      this.#global.getOrCreate(threadId);
      const last = runs.length - 1;
      runs.forEach((run, position) => {
        this.#global.appendRun(threadId, {
          threadId,
          runId: run.runId,
          agentId: run.agentId,
          parentRunId: run.parentRunId,
          events: run.events,
          // Only the latest snapshot matters; the store keeps one per thread.
          messages: position === last ? run.messages : [],
          createdAt: run.createdAt,
        });
      });
    })().catch((error) => {
      this.#hydrated.delete(threadId);
      throw error;
    });
    this.#hydrated.set(threadId, loading);
    return loading;
  }

  async #authorise(threadId: string): Promise<void> {
    const user = requestUser.getStore();
    if (!user) return;
    const owner = await this.#store.ownerOf(threadId);
    if (owner && owner !== user.id) throw notFound();
  }

  override run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const user = requestUser.getStore();
    // Synelia fork: run timing (numbers only), see logRunTiming.
    const runCalledAt = performance.now();
    const arrivedAt = user?.arrivedAt ?? runCalledAt;
    const agentId = request.agent.agentId ?? "default";
    return defer(() =>
      from(
        (async () => {
          if (user) {
            const owner = await this.#store.ownerOf(request.threadId);
            if (owner && owner !== user.id) throw notFound();
            if (!owner) {
              const { thread } = await this.#store.getOrCreateThread({
                threadId: request.threadId,
                userId: user.id,
                agentId,
              });
              this.#index.set(thread.id, thread);
            }
          }
          await this.hydrate(request.threadId);
          // Synelia fork: the hidden QA model is honoured for administrators only. Anybody else
          // who names it gets the default, exactly as for an id outside the allowlist.
          const picked = pickedModel(request);
          if (
            picked &&
            user?.role !== "admin" &&
            isHiddenModel(picked, await this.#models().catch(() => undefined))
          ) {
            request = {
              ...request,
              input: {
                ...request.input,
                context: (request.input.context ?? []).filter(
                  (entry) => entry.description !== "Synelia model",
                ),
              },
            };
          }
        })(),
      ),
    ).pipe(
      switchMap(() => {
        // Synelia fork: the Bot never sees tools outside the pilot (agent computer, sandboxed UI),
        // whatever the browser registered.
        const preparedAt = performance.now();
        const tools = pilotTools(request.input.tools);
        if (tools !== request.input.tools)
          request = {
            ...request,
            input: { ...request.input, tools: tools ?? [] },
          };
        // Synelia fork (idempotent send): the person's newest message was already answered by a
        // finished run of this thread (double click, resend after a reconnect). Answer with an
        // empty, finished run instead of running the model a second time.
        const historic =
          this.#global.peek(request.threadId)?.historicRuns ?? [];
        if (isAlreadyAnswered(request.input.messages, historic)) {
          return of(
            {
              type: "RUN_STARTED",
              threadId: request.threadId,
              runId: request.input.runId,
            } as BaseEvent,
            {
              type: "RUN_FINISHED",
              threadId: request.threadId,
              runId: request.input.runId,
            } as BaseEvent,
          );
        }
        let stream: Observable<BaseEvent>;
        try {
          stream = super.run(request);
        } catch (error) {
          // Synelia fork: the in-memory runner's concurrent-run refusal, otherwise a bare stream
          // error the browser never sees. Sent as a RUN_ERROR carrying `code: "thread_busy"`.
          if (isThreadAlreadyRunning(error))
            return of(...threadBusyEvents(request));
          throw error;
        }
        const runId = request.input.runId;
        const persist = (status: string) => {
          const store = this.#global.peek(request.threadId);
          const run = store?.historicRuns.find(
            (candidate) => candidate.runId === runId,
          );
          if (!run) return;
          // Synelia fork: a RUN_ERROR carries a stable code, and a finish with no text and no tool
          // call becomes a provider_refusal RUN_ERROR, so a reload still shows the French notice.
          const adjusted = adjustPersistedRun(run.events);
          void this.#models()
            .catch(() => undefined)
            .then((list) =>
              this.#store.saveRun({
                runId,
                threadId: request.threadId,
                agentId,
                parentRunId: run.parentRunId ?? null,
                events: adjusted.events,
                messages: store?.messagesSnapshot ?? [],
                createdAt: run.createdAt ?? Date.now(),
                // A provider failure (or a silent refusal, adjusted above) stores as error; a stream
                // that threw does too even when its events do not say so.
                status:
                  status === "error" ? "error" : adjusted.status,
                // The model that really answered: allowlist + availability + default fallback,
                // the rule Mastra applies, never the browser's header as sent.
                ...resolveModel(pickedModel(request), list),
                ...(user ? { userId: user.id } : {}),
              }),
            )
            .catch((error) =>
              console.error(
                JSON.stringify({
                  type: "synelia-run-persist-failed",
                  threadId: request.threadId,
                  runId,
                  reason:
                    error instanceof Error ? error.message : String(error),
                }),
              ),
            );
        };
        // The stream is a ReplaySubject: a second subscriber sees the same events, and completes
        // after the in-memory store has appended the run, which is what `persist` reads.
        stream.subscribe({
          complete: () => persist("done"),
          error: () => persist("error"),
        });
        let firstEventAt: number | undefined;
        let firstTextAt: number | undefined;
        // Synelia fork: the provider half of the requested `provider:model`, logged next to the
        // outcome. The derived finish class (stop / tool_call / provider_refusal / an error code)
        // is read from the recorded events at completion; the raw provider finish_reason is logged
        // at the provider boundary (agent-mastra timedFetch), never here.
        const requestedModel = pickedModel(request);
        const requestedProvider = requestedModel?.includes(":")
          ? requestedModel.slice(0, requestedModel.indexOf(":"))
          : undefined;
        const timing = (outcome: string) =>
          logRunTiming({
            threadId: request.threadId,
            runId,
            userId: user?.id,
            outcome,
            model: requestedModel,
            provider: requestedProvider,
            finishReason: finishClass(
              this.#global.peek(request.threadId)?.historicRuns.find(
                (candidate) => candidate.runId === runId,
              )?.events ?? [],
            ),
            // arrival -> runner.run(): auth, role, CopilotKit runtime request handling
            routeMs: runCalledAt - arrivedAt,
            // runner.run() -> agent call: ownership, hydrate, QA-model check
            prepMs: preparedAt - runCalledAt,
            // agent call -> first AG-UI event from Mastra (RUN_STARTED)
            firstEventMs:
              firstEventAt === undefined
                ? undefined
                : firstEventAt - preparedAt,
            // agent call -> first TEXT_MESSAGE_CONTENT (Mastra build + model first token)
            firstTextMs:
              firstTextAt === undefined ? undefined : firstTextAt - preparedAt,
            sinceArrivalFirstTextMs:
              firstTextAt === undefined ? undefined : firstTextAt - arrivedAt,
            totalMs: performance.now() - arrivedAt,
            tools: request.input.tools?.length ?? 0,
            messages: request.input.messages?.length ?? 0,
            contextBytes: JSON.stringify(request.input.context ?? []).length,
            inputBytes: JSON.stringify(request.input).length,
          });
        stream.subscribe({
          next: (event) => {
            firstEventAt ??= performance.now();
            if (
              event.type === "TEXT_MESSAGE_CONTENT" ||
              event.type === "TEXT_MESSAGE_CHUNK"
            )
              firstTextAt ??= performance.now();
          },
          complete: () => timing("done"),
          error: () => timing("error"),
        });
        return stream;
      }),
    );
  }

  override connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    return defer(() =>
      from(
        this.#authorise(request.threadId).then(() =>
          this.hydrate(request.threadId),
        ),
      ),
    ).pipe(switchMap(() => super.connect(request)));
  }

  /** Called by the request middleware before the runtime's synchronous thread endpoints. */
  async prepareThreadRead(threadId: string): Promise<boolean> {
    const user = requestUser.getStore();
    const owner = await this.#store.ownerOf(threadId);
    if (user && owner && owner !== user.id) return false;
    await this.hydrate(threadId);
    return true;
  }

  override listThreads() {
    const user = requestUser.getStore();
    return [...this.#index.values()]
      .filter(
        (thread) =>
          !thread.archived && (!user || thread.createdById === user.id),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((thread) => ({
        id: thread.id,
        name: thread.name,
        agentId: thread.agentId,
        organizationId: "" as const,
        createdById: "" as const,
        archived: false as const,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      }));
  }

  override clearThreads(): void {
    // Durable history is not wiped by a page load. Deliberately a no-op.
  }
}

/** The "Synelia model" context entry as the browser sent it (`provider:model`), unvalidated. */
export function pickedModel(
  request: AgentRunnerRunRequest,
): string | undefined {
  const entry = (request.input.context ?? []).find(
    (candidate) => candidate.description === "Synelia model",
  );
  const value =
    typeof entry?.value === "string"
      ? entry.value.replace(/^"|"$/g, "").trim()
      : "";
  return value || undefined;
}

/**
 * Synelia fork: the run currently streaming on this thread in THIS process (the open runner keeps
 * live runs in memory), or undefined. Read from the runtime's global store, shared by every runner
 * instance, so the thread status route needs no handle on the runner.
 */
export function liveRunId(threadId: string): string | undefined {
  const store = (
    ɵGLOBAL_STORE as unknown as {
      peek(
        id: string,
      ): { isRunning?: boolean; currentRunId?: string | null } | undefined;
    }
  ).peek(threadId);
  return store?.isRunning && store.currentRunId
    ? store.currentRunId
    : undefined;
}

/**
 * Synelia fork: true when the last message of `messages` is the person's and a FINISHED historic
 * run already received it as input. A failed or stopped run does not count, so "send again" after
 * an error still runs.
 */
export function isAlreadyAnswered(
  messages: readonly { id: string; role: string }[] | undefined,
  historicRuns: readonly { events: readonly BaseEvent[] }[],
): boolean {
  const last = messages?.at(-1);
  if (last?.role !== "user") return false;
  return historicRuns.some((run) => {
    if (!run.events.some((event) => event.type === "RUN_FINISHED"))
      return false;
    return run.events.some(
      (event) =>
        event.type === "RUN_STARTED" &&
        (
          (event as { input?: { messages?: { id: string }[] } }).input
            ?.messages ?? []
        ).some((message) => message.id === last.id),
    );
  });
}
