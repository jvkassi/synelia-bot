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
import { SQL } from "bun";
import { addressOf } from "../db/client";
import { LOCAL_PERSISTENCE_DDL } from "./schema";

class LocalIntelligenceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LocalIntelligenceError";
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
const UNOWNED = "__unowned__";

export class LocalIntelligence {
  readonly local = true as const;
  readonly #sql: SQL;
  #ready: Promise<void> | undefined;

  constructor(databaseUrl: string) {
    this.#sql = new SQL({ ...addressOf(databaseUrl), max: 5 });
  }

  /** Creates the tables once per process. Every public method awaits it. */
  ready(): Promise<void> {
    this.#ready ??= this.#sql
      .unsafe(LOCAL_PERSISTENCE_DDL)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#ready = undefined;
        throw error;
      });
    return this.#ready;
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
    throw new LocalIntelligenceError("Trajectories are not available locally.", 501);
  }

  // ---- memory: handled by memory/store.ts local tables ----------------------------------------
  async listMemories() {
    return { memories: [] };
  }
  async recallMemories() {
    return { memories: [] };
  }
  async createMemory(): Promise<never> {
    throw new LocalIntelligenceError("Memory is stored in OpenBot tables locally.", 501);
  }
  async updateMemory(): Promise<never> {
    throw new LocalIntelligenceError("Memory is stored in OpenBot tables locally.", 501);
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

  async createThread(params: { threadId: string; userId: string; agentId: string; name?: string }) {
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
      await this.#sql`UPDATE synelia_thread SET user_id = ${params.userId} WHERE id = ${params.threadId}`;
      existing.user_id = params.userId;
    }
    // Same answer as a missing thread: an id never discloses somebody else's conversation.
    if (existing.user_id !== params.userId) throw new LocalIntelligenceError("Thread not found.", 404);
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
    return toSummary(rows[0] as ThreadRow);
  }

  async archiveThread(params: { threadId: string; userId: string; agentId: string }) {
    await this.updateThread({ ...params, updates: { archived: true } });
  }

  async deleteThread(params: { threadId: string; userId: string }) {
    await this.getThread(params);
    await this.#sql`UPDATE synelia_thread SET deleted_at = now() WHERE id = ${params.threadId}`;
  }

  async getThreadMessages(params: { threadId: string; userId: string }) {
    await this.ready();
    const row = await this.#row(params.threadId);
    // A thread nobody has run yet reads as empty, like IntelligenceKnowingANewThread.
    if (!row) return { messages: [] };
    if (row.user_id !== params.userId) throw new LocalIntelligenceError("Thread not found.", 404);
    const runs = (await this.#sql`
      SELECT messages FROM synelia_thread_run
      WHERE thread_id = ${params.threadId} AND jsonb_array_length(messages) > 0
      ORDER BY seq DESC LIMIT 1`) as { messages: unknown }[];
    return { messages: jsonArray(runs[0]?.messages) as never[] };
  }

  async getThreadEvents(params: { threadId: string }) {
    const runs = await this.loadRuns(params.threadId);
    return { events: runs.flatMap((run) => run.events) as never[], decodeErrorRowIds: [], truncated: false };
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
    run: StoredRun & { userId?: string; status: string; provider?: string; model?: string },
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
      INSERT INTO synelia_thread_run (run_id, thread_id, agent_id, parent_run_id, status, provider, model, events, messages)
      VALUES (${run.runId}, ${run.threadId}, ${run.agentId}, ${run.parentRunId}, ${run.status},
              ${run.provider ?? null}, ${run.model ?? null},
              ${JSON.stringify(run.events)}::text::jsonb, ${JSON.stringify(run.messages)}::text::jsonb)
      ON CONFLICT (run_id) DO UPDATE SET events = EXCLUDED.events, messages = EXCLUDED.messages,
        status = EXCLUDED.status`;
    await this.#sql`
      UPDATE synelia_thread SET updated_at = now(), last_run_at = now() WHERE id = ${run.threadId}`;
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

  /** Provider and model of the run that wrote assistant message `messageId`, for its owner. */
  async messageModel(params: { messageId: string; userId: string }) {
    await this.ready();
    const probe = JSON.stringify([{ type: "TEXT_MESSAGE_START", messageId: params.messageId }]);
    const rows = (await this.#sql`
      SELECT r.provider, r.model, r.status FROM synelia_thread_run r
      JOIN synelia_thread t ON t.id = r.thread_id
      WHERE t.user_id = ${params.userId} AND t.deleted_at IS NULL
        AND r.events @> ${probe}::text::jsonb
      ORDER BY r.seq DESC LIMIT 1`) as { provider: string | null; model: string | null; status: string }[];
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
        WHERE synelia_thread_lock.expires_at < now()
      RETURNING run_id`) as { run_id: string }[];
    if (!rows[0]) throw new LocalIntelligenceError("Thread is busy.", 409);
    return {
      threadId: params.threadId,
      runId: params.runId,
      joinToken: "",
      lock: { key: params.threadId, ttlSeconds: ttl },
    };
  }

  async ɵrenewThreadLock(params: { threadId: string; runId: string; ttlSeconds: number }) {
    await this.ready();
    await this.#sql`
      UPDATE synelia_thread_lock SET expires_at = now() + make_interval(secs => ${params.ttlSeconds})
      WHERE thread_id = ${params.threadId} AND run_id = ${params.runId}`;
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
