/**
 * Synelia phase 0: a Postgres stand-in for the parts of `CopilotKitIntelligence` OpenBot calls.
 *
 * OpenBot v0.2.0 hard-wires CopilotKit Intelligence (a hosted service) for durable threads, thread
 * locks, memory and learning. This class answers the same public methods from this deployment's own
 * Postgres, so the rest of the server keeps its call sites and only the construction changes
 * (see `createIntelligenceClient` and `mountCopilotRuntime`).
 *
 *  - threads (ThreadStore): `synelia_thread` + messages from the latest run snapshot in
 *    `synelia_thread_run`, which `PostgresAgentRunner` writes.
 *  - thread locks: `synelia_thread_lock` rows with an expiry.
 *  - memory (MemoryStore): NOT here. `getRuntimeEntitlements` reports "not entitled", which makes
 *    `memory/store.ts` keep memories in OpenBot's own tables, exactly as for an unlicensed
 *    Intelligence. The memory methods only satisfy the type.
 *  - learning / inspector (LearningStore): stubs.
 *
 * Errors carry `status` like the SDK's typed HTTP errors, because callers branch on 404 and 409.
 */

import type { BaseEvent } from "@ag-ui/client";
import { SQL } from "bun";
import { addressOf } from "../db/client";
import {
  computeRetryable,
  EFFECTFUL_TOOLS,
  replayEvents,
} from "../synelia/run-refusal";
import { LOCAL_PERSISTENCE_DDL } from "./schema";

class LocalIntelligenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * Synelia fork: machine-readable reason, e.g. `thread_busy`. Not written to any HTTP body:
     * the browser gets `thread_busy` as a RUN_ERROR from the in-memory refusal
     * (postgres-runner.ts `threadBusyEvents`).
     */
    readonly code?: string,
  ) {
    super(message);
    // The name the platform client gives its errors: toolkit/src/lease.ts `isLockConflict` reads it
    // (with status 409) to stop a turn whose lock was lost.
    this.name = "PlatformRequestError";
  }
}

export type LocalThreadSummary = {
  id: string;
  name: string | null;
  agentId: string;
  createdById: string;
  organizationId: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
};

export type StoredRun = {
  runId: string;
  threadId: string;
  agentId: string;
  parentRunId: string | null;
  events: unknown[];
  messages: unknown[];
  createdAt: number;
};

type ThreadRow = {
  id: string;
  user_id: string;
  agent_id: string;
  name: string | null;
  archived: boolean;
  created_at: Date;
  updated_at: Date;
  last_run_at: Date | null;
};

const iso = (value: Date | string | null | undefined) =>
  value ? new Date(value).toISOString() : undefined;

const jsonArray = (value: unknown) =>
  (Array.isArray(value)
    ? value
    : typeof value === "string"
      ? JSON.parse(value)
      : []) as unknown[];

function toSummary(row: ThreadRow): LocalThreadSummary {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    createdById: row.user_id,
    organizationId: "",
    archived: row.archived,
    createdAt: iso(row.created_at) as string,
    updatedAt: iso(row.updated_at) as string,
    ...(row.last_run_at ? { lastRunAt: iso(row.last_run_at) } : {}),
  };
}

const NOOP_UNSUBSCRIBE = () => () => {};

/**
 * The DDL runs once per process and database, not once per instance: its `ALTER TABLE ... ADD
 * COLUMN IF NOT EXISTS` takes an ACCESS EXCLUSIVE lock on synelia_thread_run even when the column
 * exists, so every new instance (tests build many) queued behind, and blocked, any open use of the
 * table. A failed run is forgotten so the next caller retries.
 */
const schemaReady = new Map<string, Promise<unknown>>();
function ensureSchema(key: string, run: () => Promise<unknown>) {
  let pending = schemaReady.get(key);
  if (!pending) {
    pending = run().catch((error: unknown) => {
      schemaReady.delete(key);
      throw error;
    });
    schemaReady.set(key, pending);
  }
  return pending;
}
const UNOWNED = "__unowned__";

export class LocalIntelligence {
  readonly local = true as const;
  readonly #sql: SQL;
  #ready: Promise<void> | undefined;

  readonly #expireLocksAtBoot: boolean;
  readonly #schemaKey: string;

  /**
   * `expireLocksAtBoot` defaults to on; the test preload sets SYNELIA_BOOT_EXPIRE_LOCKS=0 so one test
   * file's instance never expires the locks another file is holding in the shared test database.
   */
  constructor(
    databaseUrl: string,
    options: { expireLocksAtBoot?: boolean } = {},
  ) {
    this.#sql = new SQL({ ...addressOf(databaseUrl), max: 5 });
    this.#schemaKey = databaseUrl;
    this.#expireLocksAtBoot =
      options.expireLocksAtBoot ??
      process.env.SYNELIA_BOOT_EXPIRE_LOCKS !== "0";
  }

  /** Creates the tables once per process. Every public method awaits it. */
  ready(): Promise<void> {
    this.#ready ??= ensureSchema(this.#schemaKey, () =>
      this.#sql.unsafe(LOCAL_PERSISTENCE_DDL),
    )
      .then(async () => {
        if (!this.#expireLocksAtBoot) return;
        // Single-instance assumption: at boot no turn can be running in this process, so every
        // unexpired lock is stale: expire it (a restart mid-run would otherwise read as "in
        // progress" until expiry). The row stays, so the page can tell the turn was interrupted.
        // Goes away in phase 1 with incremental thread_event writes.
        const cleared = await this
          .#sql`UPDATE synelia_thread_lock SET expires_at = now() WHERE expires_at > now()`;
        if (cleared.count > 0)
          console.info(
            `[synelia] ${cleared.count} verrou(s) de fil obsolète(s) expiré(s) au démarrage`,
          );
      })
      .catch((error: unknown) => {
        this.#ready = undefined;
        throw error;
      });
    return this.#ready;
  }

  /** Closes this instance's pool (tests; a server keeps its one instance for the process). */
  async close(): Promise<void> {
    await this.#sql.close();
  }

  // ---- realtime subscriptions: no gateway in local mode ---------------------------------------
  onThreadCreated = NOOP_UNSUBSCRIBE;
  onThreadUpdated = NOOP_UNSUBSCRIBE;
  onThreadDeleted = NOOP_UNSUBSCRIBE;

  ɵgetApiUrl() {
    return "local://postgres";
  }
  ɵgetRunnerWsUrl() {
    return "";
  }
  ɵgetClientWsUrl() {
    return "";
  }
  ɵgetChannelsWsUrl() {
    return "";
  }
  ɵgetRunnerAuthToken() {
    return "";
  }
  ɵgetApiKey() {
    return "";
  }
  ɵgetLearningContainerId() {
    return undefined;
  }
  ɵisEnterpriseLearningEnabled() {
    return false;
  }

  // ---- entitlements / learning (LearningStore stub) -------------------------------------------
  async getRuntimeEntitlements(): Promise<never> {
    throw new LocalIntelligenceError(
      "Local Postgres persistence: CopilotKit Intelligence is not used by this deployment.",
      501,
    );
  }
  async getLearnedSkillsSnapshot(): Promise<never> {
    throw new LocalIntelligenceError("Learning is not available locally.", 501);
  }
  async getLearnedSkillsSnapshots(): Promise<never[]> {
    return [];
  }
  async getInspectorMetadata() {
    return undefined;
  }
  async getInspectorLearning(): Promise<never> {
    throw new LocalIntelligenceError("Learning is not available locally.", 501);
  }
  async ɵconnectTrajectory(): Promise<never> {
    throw new LocalIntelligenceError(
      "Trajectories are not available locally.",
      501,
    );
  }

  // ---- memory: handled by memory/store.ts local tables ----------------------------------------
  async listMemories() {
    return { memories: [] };
  }
  async recallMemories() {
    return { memories: [] };
  }
  async createMemory(): Promise<never> {
    throw new LocalIntelligenceError(
      "Memory is stored in OpenBot tables locally.",
      501,
    );
  }
  async updateMemory(): Promise<never> {
    throw new LocalIntelligenceError(
      "Memory is stored in OpenBot tables locally.",
      501,
    );
  }
  async removeMemory(): Promise<void> {}
  async ɵsubscribeToThreads() {
    return { joinToken: "" };
  }
  async ɵsubscribeToMemories() {
    return {};
  }
  async annotate() {
    return { id: crypto.randomUUID(), duplicate: false };
  }
  async ɵgetManagedChannelAsset(): Promise<never> {
    throw new LocalIntelligenceError("No managed channel assets locally.", 404);
  }

  /** Told after every rename, archive, delete or title change (the runner's in-memory index). */
  readonly #threadListeners = new Set<(change: ThreadChange) => void>();
  onThreadChange(listener: (change: ThreadChange) => void): () => void {
    this.#threadListeners.add(listener);
    return () => this.#threadListeners.delete(listener);
  }
  #emit(change: ThreadChange) {
    for (const listener of this.#threadListeners) listener(change);
  }

  // ---- threads (ThreadStore) ------------------------------------------------------------------
  async listThreads(params: {
    userId: string;
    agentId?: string;
    includeArchived?: boolean;
    limit?: number;
  }) {
    await this.ready();
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const rows = (await this.#sql`
      SELECT * FROM synelia_thread
      WHERE user_id = ${params.userId}
        AND deleted_at IS NULL
        AND (${params.agentId ?? null}::text IS NULL OR agent_id = ${params.agentId ?? null})
        AND (${params.includeArchived === true} OR archived = false)
      ORDER BY updated_at DESC
      LIMIT ${limit}`) as ThreadRow[];
    return { threads: rows.map(toSummary), joinCode: "", nextCursor: null };
  }

  /** Every live thread, for warming the runner's in-memory index at boot. */
  async listAllThreads(): Promise<LocalThreadSummary[]> {
    await this.ready();
    const rows = (await this.#sql`
      SELECT * FROM synelia_thread WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 5000`) as ThreadRow[];
    return rows.map(toSummary);
  }

  async createThread(params: {
    threadId: string;
    userId: string;
    agentId: string;
    name?: string;
  }) {
    return (await this.getOrCreateThread(params)).thread;
  }

  async getOrCreateThread(params: {
    threadId: string;
    userId: string;
    agentId: string;
    name?: string;
  }): Promise<{ thread: LocalThreadSummary; created: boolean }> {
    await this.ready();
    const inserted = (await this.#sql`
      INSERT INTO synelia_thread (id, user_id, agent_id, name)
      VALUES (${params.threadId}, ${params.userId}, ${params.agentId}, ${params.name ?? null})
      ON CONFLICT (id) DO NOTHING
      RETURNING *`) as ThreadRow[];
    if (inserted[0]) return { thread: toSummary(inserted[0]), created: true };
    const existing = await this.#row(params.threadId);
    if (!existing) throw new LocalIntelligenceError("Thread not found.", 404);
    if (existing.user_id === UNOWNED) {
      await this
        .#sql`UPDATE synelia_thread SET user_id = ${params.userId} WHERE id = ${params.threadId}`;
      existing.user_id = params.userId;
    }
    // Same answer as a missing thread: an id never discloses somebody else's conversation.
    if (existing.user_id !== params.userId)
      throw new LocalIntelligenceError("Thread not found.", 404);
    return { thread: toSummary(existing), created: false };
  }

  async #row(threadId: string): Promise<ThreadRow | undefined> {
    const rows = (await this.#sql`
      SELECT * FROM synelia_thread WHERE id = ${threadId} AND deleted_at IS NULL`) as ThreadRow[];
    return rows[0];
  }

  /** The owner of a thread, or undefined. Used by the runner to refuse cross-user access. */
  async ownerOf(threadId: string): Promise<string | undefined> {
    await this.ready();
    const owner = (await this.#row(threadId))?.user_id;
    return owner === UNOWNED ? undefined : owner;
  }

  async getThread(params: { threadId: string; userId: string }) {
    await this.ready();
    const row = await this.#row(params.threadId);
    if (!row || row.user_id !== params.userId) {
      throw new LocalIntelligenceError("Thread not found.", 404);
    }
    return toSummary(row);
  }

  async updateThread(params: {
    threadId: string;
    userId: string;
    agentId: string;
    updates: { name?: string; archived?: boolean };
  }) {
    await this.getThread(params);
    const rows = (await this.#sql`
      UPDATE synelia_thread SET
        name = COALESCE(${params.updates.name ?? null}, name),
        archived = COALESCE(${params.updates.archived ?? null}::boolean, archived),
        updated_at = now()
      WHERE id = ${params.threadId}
      RETURNING *`) as ThreadRow[];
    const summary = toSummary(rows[0] as ThreadRow);
    this.#emit({ kind: "updated", thread: summary });
    return summary;
  }

  async archiveThread(params: {
    threadId: string;
    userId: string;
    agentId: string;
  }) {
    await this.updateThread({ ...params, updates: { archived: true } });
  }

  async deleteThread(params: { threadId: string; userId: string }) {
    await this.getThread(params);
    await this
      .#sql`UPDATE synelia_thread SET deleted_at = now() WHERE id = ${params.threadId}`;
    this.#emit({ kind: "deleted", threadId: params.threadId });
  }

  /**
   * For the thread status route: an unexpired lock (headless turns), and whether the thread holds
   * any stored run at all (a thread with none and no live run lost its only turn: interrupted).
   */
  async threadRunState(params: { threadId: string; userId: string }) {
    await this.getThread(params);
    const rows = (await this.#sql`
      SELECT
        (SELECT run_id FROM synelia_thread_lock WHERE thread_id = ${params.threadId} AND expires_at > now()) AS locked_run,
        (SELECT l.run_id FROM synelia_thread_lock l
           WHERE l.thread_id = ${params.threadId} AND l.expires_at <= now()
             AND NOT EXISTS (SELECT 1 FROM synelia_thread_run r
                             WHERE r.thread_id = l.thread_id AND r.run_id = l.run_id)) AS lost_run`) as {
      locked_run: string | null;
      lost_run: string | null;
    }[];
    // lost: the lock expired (or was expired at boot) and the run never got stored.
    return {
      lockedRunId: rows[0]?.locked_run ?? null,
      lostRunId: rows[0]?.lost_run ?? null,
    };
  }

  /** The last run of the thread, if it ended in error, with its stored technical message. */
  async lastRunError(params: { threadId: string; userId: string }) {
    await this.getThread(params);
    const rows = (await this.#sql`
      SELECT run_id, status, provider, model, events FROM synelia_thread_run
      WHERE thread_id = ${params.threadId} ORDER BY seq DESC LIMIT 1`) as {
      run_id: string;
      status: string;
      provider: string | null;
      model: string | null;
      events: unknown;
    }[];
    const last = rows[0];
    if (last?.status !== "error") return null;
    const event = jsonArray(last.events).find(
      (candidate) => (candidate as { type?: string }).type === "RUN_ERROR",
    ) as { message?: unknown; code?: unknown } | undefined;
    return {
      runId: last.run_id,
      provider: last.provider,
      model: last.model,
      message: typeof event?.message === "string" ? event.message : null,
      // Synelia fork: the stable error code (provider_refusal, provider_unavailable, a stall code).
      // The front maps it to French and prefers it over reading the English message.
      code: typeof event?.code === "string" ? event.code : null,
      // Synelia fork: derived at READ from the run's tool calls, never trusted from stored metadata,
      // so a legacy run that ran an effectful tool (report_refusal) comes out not retryable.
      retryable: computeRetryable(
        jsonArray(last.events) as BaseEvent[],
        EFFECTFUL_TOOLS,
      ),
    };
  }

  /**
   * Synelia fork (pass10b, blocker 1): the id of the LAST stored user message of the thread, or null
   * when none is stored. Same owner rule as getThreadMessages (somebody else's thread = 404). The
   * thread status route returns it so a browser whose stream was cut before RUN_STARTED can tell
   * "this POST's message is stored" (reattach) from "the thread exists but this message never
   * arrived" (not sent) — `known` alone only says the thread exists.
   */
  async lastUserMessageId(params: {
    threadId: string;
    userId: string;
  }): Promise<string | null> {
    const { messages } = await this.getThreadMessages(params);
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index] as { id?: unknown; role?: unknown };
      if (message.role === "user")
        return typeof message.id === "string" ? message.id : null;
    }
    return null;
  }

  async getThreadMessages(params: { threadId: string; userId: string }) {
    await this.ready();
    const row = await this.#row(params.threadId);
    // A thread nobody has run yet reads as empty, like IntelligenceKnowingANewThread.
    if (!row) return { messages: [] };
    if (row.user_id !== params.userId)
      throw new LocalIntelligenceError("Thread not found.", 404);
    // Synelia fork (item 3): the latest message snapshot carries the whole conversation, INCLUDING
    // the assistant text of a superseded error run or a provider_refusal run. That text is dropped on
    // reload (THE SINGLE REPLAY RULE, replayEvents) so a reconnecting browser never sees the English
    // refusal; it must not reach the MODEL next turn either. So the same rule gates this read: an
    // assistant message whose id replayEvents drops is removed from the returned snapshot. The user's
    // own messages and surviving answers are untouched.
    const runs = await this.loadRuns(params.threadId);
    if (runs.length === 0) return { messages: [] };
    const snapshotRun = [...runs]
      .reverse()
      .find((run) => (run.messages?.length ?? 0) > 0);
    const messages = (snapshotRun?.messages ?? []) as {
      id?: unknown;
      role?: unknown;
    }[];
    const kept = new Set(
      assistantMessageIds(
        replayEvents(
          runs as Parameters<typeof replayEvents>[0],
          EFFECTFUL_TOOLS,
        ),
      ),
    );
    const dropped = new Set(
      assistantMessageIds(runs.flatMap((run) => run.events)).filter(
        (id) => !kept.has(id),
      ),
    );
    return {
      messages: messages.filter(
        (message) =>
          !(
            message.role === "assistant" &&
            typeof message.id === "string" &&
            dropped.has(message.id)
          ),
      ) as never[],
    };
  }

  async getThreadEvents(params: { threadId: string }) {
    const runs = await this.loadRuns(params.threadId);
    // Synelia fork (item 3): THE SINGLE REPLAY RULE (replayEvents) also gates the event read, so a
    // superseded error run's or a provider_refusal run's assistant output is dropped here exactly as
    // it is on connect() reload — the model's next turn is built from these events and must not carry
    // the hidden English refusal.
    return {
      events: replayEvents(
        runs as Parameters<typeof replayEvents>[0],
        EFFECTFUL_TOOLS,
      ) as never[],
      decodeErrorRowIds: [],
      truncated: false,
    };
  }

  async getThreadState() {
    return { kind: "no-snapshot" as const };
  }

  // ---- run journal (written by PostgresAgentRunner) -------------------------------------------
  async loadRuns(threadId: string): Promise<StoredRun[]> {
    await this.ready();
    const rows = (await this.#sql`
      SELECT run_id, thread_id, agent_id, parent_run_id, events, messages, created_at
      FROM synelia_thread_run WHERE thread_id = ${threadId} ORDER BY seq ASC`) as {
      run_id: string;
      thread_id: string;
      agent_id: string;
      parent_run_id: string | null;
      events: unknown;
      messages: unknown;
      created_at: Date;
    }[];
    return rows.map((row) => ({
      runId: row.run_id,
      threadId: row.thread_id,
      agentId: row.agent_id,
      parentRunId: row.parent_run_id,
      events: jsonArray(row.events),
      messages: jsonArray(row.messages),
      createdAt: new Date(row.created_at).getTime(),
    }));
  }

  async saveRun(
    run: StoredRun & {
      userId?: string;
      status: string;
      provider?: string;
      model?: string;
    },
  ) {
    await this.ready();
    // No owner known (a headless run that skipped the lock): keep the run under a placeholder owner
    // so nothing is lost; the first person to claim the thread through getOrCreateThread owns it.
    await this.#sql`
      INSERT INTO synelia_thread (id, user_id, agent_id)
      VALUES (${run.threadId}, ${run.userId ?? UNOWNED}, ${run.agentId})
      ON CONFLICT (id) DO NOTHING`;
    // `::text::jsonb`: Bun binds a string parameter as a JSON string scalar when cast straight to
    // jsonb, which stored every journal as one quoted string.
    await this.#sql`
      INSERT INTO synelia_thread_run (run_id, thread_id, agent_id, parent_run_id, status, provider, model, message_ids, events, messages)
      VALUES (${run.runId}, ${run.threadId}, ${run.agentId}, ${run.parentRunId}, ${run.status},
              ${run.provider ?? null}, ${run.model ?? null},
              ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(assistantMessageIds(run.events))}::text::jsonb)),
              ${JSON.stringify(run.events)}::text::jsonb, ${JSON.stringify(run.messages)}::text::jsonb)
      ON CONFLICT (run_id) DO UPDATE SET events = EXCLUDED.events, messages = EXCLUDED.messages,
        status = EXCLUDED.status, message_ids = EXCLUDED.message_ids,
        provider = COALESCE(EXCLUDED.provider, synelia_thread_run.provider),
        model = COALESCE(EXCLUDED.model, synelia_thread_run.model)`;
    // (Synelia fork: a re-save never erases the provider/model an earlier save recorded.)
    // Title: set once, from the first user message of the first run that did not fail. A name that
    // is already there (an earlier title or an explicit rename) is never overwritten.
    const title = run.status === "error" ? null : threadTitle(run.messages);
    const rows = (await this.#sql`
      UPDATE synelia_thread SET updated_at = now(), last_run_at = now(),
        name = COALESCE(name, ${title})
      WHERE id = ${run.threadId}
      RETURNING *`) as ThreadRow[];
    if (rows[0]) this.#emit({ kind: "updated", thread: toSummary(rows[0]) });
  }

  /** Provider and model a run asked for, if the run belongs to `userId`. For "model on answer". */
  async runModel(params: { runId: string; userId: string }) {
    await this.ready();
    const rows = (await this.#sql`
      SELECT r.provider, r.model, r.status FROM synelia_thread_run r
      JOIN synelia_thread t ON t.id = r.thread_id
      WHERE r.run_id = ${params.runId} AND t.user_id = ${params.userId} AND t.deleted_at IS NULL`) as {
      provider: string | null;
      model: string | null;
      status: string;
    }[];
    return rows[0];
  }

  /**
   * For the "model under each answer" badge: the LAST assistant message of every stored run of the
   * thread → provider/model of that run. One owner-checked read per thread (404 for anybody else).
   */
  async threadMessageModels(params: { threadId: string; userId: string }) {
    await this.getThread(params);
    const rows = (await this.#sql`
      SELECT message_ids[array_length(message_ids, 1)] AS message_id, provider, model
      FROM synelia_thread_run
      WHERE thread_id = ${params.threadId} AND array_length(message_ids, 1) > 0 AND model IS NOT NULL
      ORDER BY seq`) as {
      message_id: string;
      provider: string | null;
      model: string;
    }[];
    const map: Record<string, { provider: string | null; model: string }> = {};
    for (const row of rows)
      map[row.message_id] = { provider: row.provider, model: row.model };
    return map;
  }

  /** Provider and model of the run that wrote assistant message `messageId`, for its owner. */
  async messageModel(params: { messageId: string; userId: string }) {
    await this.ready();
    const probe = JSON.stringify([
      { type: "TEXT_MESSAGE_START", messageId: params.messageId },
    ]);
    const rows = (await this.#sql`
      SELECT r.provider, r.model, r.status FROM synelia_thread_run r
      JOIN synelia_thread t ON t.id = r.thread_id
      WHERE t.user_id = ${params.userId} AND t.deleted_at IS NULL
        AND (r.message_ids @> ARRAY[${params.messageId}]::text[] OR r.events @> ${probe}::text::jsonb)
      ORDER BY r.seq DESC LIMIT 1`) as {
      provider: string | null;
      model: string | null;
      status: string;
    }[];
    return rows[0];
  }

  // ---- thread locks ---------------------------------------------------------------------------
  async ɵacquireThreadLock(params: {
    threadId: string;
    runId: string;
    userId: string;
    agentId: string;
    ttlSeconds?: number;
  }) {
    await this.ready();
    const ttl = params.ttlSeconds ?? 120;
    const rows = (await this.#sql`
      INSERT INTO synelia_thread_lock (thread_id, run_id, expires_at)
      VALUES (${params.threadId}, ${params.runId}, now() + make_interval(secs => ${ttl}))
      ON CONFLICT (thread_id) DO UPDATE
        SET run_id = EXCLUDED.run_id, expires_at = EXCLUDED.expires_at
        WHERE synelia_thread_lock.expires_at <= now()
           OR synelia_thread_lock.run_id = EXCLUDED.run_id
      RETURNING run_id`) as { run_id: string }[];
    if (!rows[0])
      throw new LocalIntelligenceError("Thread is busy.", 409, "thread_busy");
    return {
      threadId: params.threadId,
      runId: params.runId,
      joinToken: "",
      lock: { key: params.threadId, ttlSeconds: ttl },
    };
  }

  async ɵrenewThreadLock(params: {
    threadId: string;
    runId: string;
    ttlSeconds: number;
  }) {
    await this.ready();
    const rows = (await this.#sql`
      UPDATE synelia_thread_lock SET expires_at = now() + make_interval(secs => ${params.ttlSeconds})
      WHERE thread_id = ${params.threadId} AND run_id = ${params.runId}
      RETURNING run_id`) as { run_id: string }[];
    // The lock expired and was taken by another run (or cleaned up): this run no longer holds it.
    // 409 + PlatformRequestError is what keepLease treats as "lost", and the turn is stopped.
    if (!rows[0]) throw new LocalIntelligenceError("Thread lock lost.", 409);
    return { ttlSeconds: params.ttlSeconds };
  }

  async ɵcleanupThreadLock(params: { threadId: string; runId: string }) {
    await this.ready();
    await this.#sql`
      DELETE FROM synelia_thread_lock WHERE thread_id = ${params.threadId} AND run_id = ${params.runId}`;
  }

  async ɵgetActiveJoinCode(params: { threadId: string }) {
    return { threadId: params.threadId, joinToken: "" };
  }

  async ɵconnectThread() {
    return null;
  }
}

let shared: LocalIntelligence | undefined;

/** One pool per process, whatever number of call sites ask for "an Intelligence client". */
export function localIntelligence(databaseUrl: string): LocalIntelligence {
  shared ??= new LocalIntelligence(databaseUrl);
  return shared;
}

export type ThreadChange =
  | { kind: "updated"; thread: LocalThreadSummary }
  | { kind: "deleted"; threadId: string };

/** First user message, markdown stripped (** __ # ` > list marks, links), cut near 60 chars. */
export function threadTitle(messages: unknown[]): string | null {
  const first = messages.find(
    (message) => (message as { role?: string }).role === "user",
  ) as { content?: unknown } | undefined;
  const raw =
    typeof first?.content === "string"
      ? first.content
      : Array.isArray(first?.content)
        ? first.content
            .map((part) =>
              typeof (part as { text?: unknown }).text === "string"
                ? (part as { text: string }).text
                : "",
            )
            .join(" ")
        : "";
  const plain = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return null;
  if (plain.length <= 60) return plain;
  const cut = plain.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Assistant messageIds a run wrote, in first-seen order (START and CHUNK events both carry them). */
export function assistantMessageIds(events: unknown[]): string[] {
  const ids: string[] = [];
  for (const event of events as { type?: string; messageId?: unknown }[]) {
    if (
      (event.type === "TEXT_MESSAGE_START" ||
        event.type === "TEXT_MESSAGE_CHUNK") &&
      typeof event.messageId === "string" &&
      !ids.includes(event.messageId)
    )
      ids.push(event.messageId);
  }
  return ids;
}
