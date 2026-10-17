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
import {
  concatMap,
  defer,
  from,
  map,
  type Observable,
  of,
  switchMap,
} from "rxjs";
import {
  isHiddenModel,
  resolveModel,
  type SyneliaModelList,
} from "../synelia/models";
import { pilotTools } from "../synelia/pilot-gate";
import { logRunEvent, logRunTiming } from "../synelia/request-log";
import {
  adjustPersistedRun,
  assistantTextFromEvents,
  computeRetryable,
  EFFECTFUL_TOOLS,
  finishClass,
  refusalReason,
  replayEvents,
  SYNELIA_ERROR_CODES,
  usage0Allowlist,
  usage0Refusal,
} from "../synelia/run-refusal";
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
  /**
   * Synelia fork (item 1): the in-flight persistence for a thread's latest run. persist() both
   * saves to Postgres AND rewrites the in-memory run's events to the adjusted ones, so a test (and
   * nothing in production) can await that the in-memory store matches the DB before it reloads.
   */
  readonly #persisting = new Map<string, Promise<unknown>>();
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

  /**
   * Synelia fork (item 1) test seam: resolves after the most recent run's persistence settles — the
   * Postgres save AND the in-memory adjustment that makes memory match the DB (so connect/replay and
   * isAlreadyAnswered read the adjusted events). Not used in production.
   */
  ɵpersisted(threadId: string): Promise<unknown> {
    return this.#persisting.get(threadId) ?? Promise.resolve();
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
          // Synelia fork: answered without a run (no run_timing will follow); see logRunEvent.
          logRunEvent("synelia_run_skip", {
            reason: "already_answered",
            threadId: request.threadId,
            runId: request.input.runId,
            userId: user?.id,
          });
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
          if (isThreadAlreadyRunning(error)) {
            logRunEvent("synelia_run_skip", {
              reason: "thread_busy",
              threadId: request.threadId,
              runId: request.input.runId,
              userId: user?.id,
            });
            return of(...threadBusyEvents(request));
          }
          throw error;
        }
        const runId = request.input.runId;
        // Synelia fork: accepted; a run_timing line with this runId follows when the stream ends.
        logRunEvent("synelia_run_start", {
          threadId: request.threadId,
          runId,
          userId: user?.id,
        });
        const persist = (status: string) => {
          const store = this.#global.peek(request.threadId);
          const run = store?.historicRuns.find(
            (candidate) => candidate.runId === runId,
          );
          if (!run) return;
          // Synelia fork: a RUN_ERROR carries a stable code, and a finish with no text and no tool
          // call becomes a provider_refusal RUN_ERROR, so a reload still shows the French notice.
          const settled = this.#models()
            .catch(() => undefined)
            .then((list) => {
              const resolved = resolveModel(pickedModel(request), list);
              // Synelia fork: a run that FINISHED with text, no tool call and usage PRESENT == 0 on an
              // ALLOWLISTED provider+model is turned into a provider_refusal by adjustPersistedRun
              // (reason "usage0"); the TEXT stays in storage, replayEvents hides it on reload. The
              // allowlist (SYNELIA_REFUSAL_USAGE0_MODELS) is empty by default, so this is OFF until a
              // pair is named. Every trigger is logged WITH its text under a STABLE type so
              // weekly-usage.sh can count it; the persisted RUN_ERROR metadata.reason makes it
              // countable straight from the DB too. See usage0Refusal in synelia/run-refusal.ts.
              const adjusted = adjustPersistedRun(run.events, resolved);
              if (usage0Refusal(run.events, resolved)) {
                // Synelia fork (item 4): the text that triggered THIS run, from its OWN assistant
                // deltas — never the whole thread's assistant text, which would fold in earlier,
                // unrelated answers and overstate textLength for the auditor.
                const assistantText = assistantTextFromEvents(run.events);
                console.log(
                  JSON.stringify({
                    type: "synelia_refusal_usage0_trigger",
                    threadId: request.threadId,
                    runId,
                    // The exact allowlist key matched (`${provider}:${model}`), e.g.
                    // router9:cc/claude-sonnet-5-5 — the value put in SYNELIA_REFUSAL_USAGE0_MODELS.
                    key: `${resolved.provider}:${resolved.model}`,
                    provider: resolved.provider,
                    model: resolved.model,
                    outputTokens: 0,
                    textLength: assistantText.length,
                    text: assistantText.slice(0, 2000),
                  }),
                );
              }
              // Synelia fork (item 1): memory must match the DB. The in-memory runner appended the
              // RAW events (English refusal text + a bare RUN_FINISHED); overwrite them in place with
              // the adjusted events. In THIS process a reload goes through connect(), which replays
              // from memory (not Postgres), so without this the refusal text and RUN_FINISHED would
              // survive the reload and isAlreadyAnswered would treat the turn as answered — the
              // resend would get an empty finished run. With it, replay hides the text and shows the
              // provider_refusal RUN_ERROR, and a resend of the same message runs the model again.
              run.events = adjusted.events;
              return this.#store.saveRun({
                runId,
                threadId: request.threadId,
                agentId,
                parentRunId: run.parentRunId ?? null,
                events: adjusted.events,
                messages: store?.messagesSnapshot ?? [],
                createdAt: run.createdAt ?? Date.now(),
                // A provider failure (or a silent refusal, adjusted above) stores as error; a stream
                // that threw does too even when its events do not say so.
                status: status === "error" ? "error" : adjusted.status,
                // The model that really answered: allowlist + availability + default fallback,
                // the rule Mastra applies, never the browser's header as sent.
                ...resolved,
                ...(user ? { userId: user.id } : {}),
              });
            })
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
          this.#persisting.set(request.threadId, settled);
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
              this.#global
                .peek(request.threadId)
                ?.historicRuns.find((candidate) => candidate.runId === runId)
                ?.events ?? [],
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
        // Synelia fork (LIVE path): map the terminal RUN_FINISHED through THE ONE decision
        // (refusalReason, with the resolved provider/model), so a usage0 or empty-finish refusal
        // reaches the BROWSER as a RUN_ERROR, not a bare RUN_FINISHED — never both. The model is
        // resolved (async) before the terminal event is forwarded. Persistence runs the same
        // decision on the recorded events, so live and stored outcomes cannot diverge.
        return liveRefusalTransform(
          stream,
          async () =>
            resolveModel(
              pickedModel(request),
              await this.#models().catch(() => undefined),
            ),
          { runId, threadId: request.threadId },
        );
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
    ).pipe(
      switchMap(() => {
        // Synelia fork: a RELOAD (no live run on this thread) replays stored history. Apply THE
        // SINGLE REPLAY RULE (replayEvents): drop the assistant output of superseded error runs and
        // provider_refusal runs, and stamp metadata.retryable on every RUN_ERROR. A LIVE reconnect
        // keeps the upstream stream (historic + the in-flight subject); its RUN_ERROR is stamped the
        // same way so the two paths agree.
        if (liveRunId(request.threadId))
          return super
            .connect(request)
            .pipe(
              map((event) => this.#stampRetryable(request.threadId, event)),
            );
        const runs = this.#global.peek(request.threadId)?.historicRuns ?? [];
        return from(replayEvents(runs, EFFECTFUL_TOOLS));
      }),
    );
  }

  /** Set `metadata.retryable` on a live RUN_ERROR from its run's tool-call events (reload goes
   * through replayEvents, which stamps the same way). */
  #stampRetryable(threadId: string, event: BaseEvent): BaseEvent {
    if ((event as { type?: string }).type !== "RUN_ERROR") return event;
    const runId = (event as { runId?: string }).runId;
    const run = this.#global
      .peek(threadId)
      ?.historicRuns.find((candidate) => candidate.runId === runId);
    const retryable = computeRetryable(run?.events ?? [event], EFFECTFUL_TOOLS);
    const previous = (event as { metadata?: Record<string, unknown> }).metadata;
    return {
      ...event,
      metadata: { ...(previous ?? {}), retryable },
    } as BaseEvent;
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
 * Synelia fork (LIVE refusal): transform a run's outgoing stream so its terminal RUN_FINISHED is
 * replaced by a provider_refusal RUN_ERROR when the SAME decision as persistence (refusalReason, over
 * the accumulated events with the resolved provider/model) says the finish is a silent refusal —
 * never emitting both events. The live RUN_ERROR carries metadata.retryable (computeRetryable);
 * persistence stores the same code/reason and retryable is (re)stamped by connect replay. Exported and
 * free of `this` so it is unit-testable with a synthetic stream.
 *
 * SHORT-CIRCUIT (item 5): usage0 is the only refusal reason that needs the resolved provider/model.
 * When the allowlist is empty — the default, usage0 OFF — it can never fire, so the decision is made
 * from the events alone (only empty_finish is possible) and `resolveContext` (#models(), a network/DB
 * hop) is NEVER awaited on a RUN_FINISHED. Only when the allowlist names a pair is the model resolved
 * before the terminal event is forwarded.
 */
export function liveRefusalTransform(
  stream: Observable<BaseEvent>,
  resolveContext: () => Promise<{ provider?: string; model?: string }>,
  terminal: { runId: string; threadId: string },
  allowlist: ReadonlySet<string> = usage0Allowlist(),
): Observable<BaseEvent> {
  const seen: BaseEvent[] = [];
  const refusalError = (reason: string): BaseEvent =>
    ({
      type: "RUN_ERROR",
      threadId: terminal.threadId,
      runId: terminal.runId,
      message: "content_filter",
      code: SYNELIA_ERROR_CODES.providerRefusal,
      metadata: { reason, retryable: computeRetryable(seen) },
    }) as BaseEvent;
  return stream.pipe(
    concatMap((event) => {
      seen.push(event);
      if ((event as { type?: string }).type !== "RUN_FINISHED")
        return of(event);
      // Short-circuit: no model resolution needed when usage0 is off.
      if (allowlist.size === 0) {
        const reason = refusalReason(seen, {}, allowlist);
        return of(reason ? refusalError(reason) : event);
      }
      return from(
        resolveContext().then((context): BaseEvent[] => {
          const reason = refusalReason(seen, context, allowlist);
          return reason ? [refusalError(reason)] : [event];
        }),
      ).pipe(concatMap((events) => from(events)));
    }),
  );
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
 * Synelia fork: true when the last message of `messages` is the person's and a historic run that
 * FINISHED cleanly (a RUN_FINISHED and no RUN_ERROR) already received it as input. A failed, stopped
 * or refused run does not count, so "send again" after an error still runs.
 */
export function isAlreadyAnswered(
  messages: readonly { id: string; role: string }[] | undefined,
  historicRuns: readonly { events: readonly BaseEvent[] }[],
): boolean {
  const last = messages?.at(-1);
  if (last?.role !== "user") return false;
  return historicRuns.some((run) => {
    // Answered = a clean finish. A run that also carries a RUN_ERROR did not answer (it is stored
    // status "error", see persist() above), so "send again" after a refusal or failure still runs.
    if (
      !run.events.some((event) => event.type === "RUN_FINISHED") ||
      run.events.some((event) => event.type === "RUN_ERROR")
    )
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
