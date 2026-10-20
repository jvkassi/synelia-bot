/**
 * Synelia fork (pass10c): a browser cut BEFORE RUN_STARTED while the server ACCEPTED the POST must
 * reattach, not show « non envoyé ». Runs are stored at their END, so during the run
 * `lastUserMessageId` is null (new thread) or the previous message; `activeRunId` (GET
 * /api/threads/:id, app.ts: `liveRunId(threadId) ?? lockedRunId`) is what tells the client the turn
 * arrived. `liveRunId` is set by the in-memory runner's super.run() (postgres-runner.ts:306), which
 * is called before the agent emits anything; the thread row is inserted earlier, at acceptance
 * (postgres-runner.ts:208-216, ownerOf then getOrCreateThread), so a first run is `known: true`.
 *
 * `statusOf` below is the body of the local GET /api/threads/:id route (app.ts ~2061-2075) applied
 * to the real store and the real runner registry, step for step.
 *
 * Part 1 needs NO database (fake store) and runs in the default `bun test`. Part 2 uses Postgres
 * (SYNELIA_TEST_DATABASE_URL), skipped without it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import { LocalIntelligence } from "../src/persistence/local-intelligence";
import {
  liveRunId,
  PostgresAgentRunner,
} from "../src/persistence/postgres-runner";
import { requestUser } from "../src/persistence/request-user";
import { testDatabaseUrlFrom } from "./support/database";

const ev = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, ...extra }) as unknown as BaseEvent;

/** An agent that blocks BEFORE emitting any event (no RUN_STARTED) until released. */
function blockedAgent() {
  const gate = Promise.withResolvers<void>();
  let entered = false;
  const agent = {
    agentId: "a",
    messages: [] as unknown[],
    get entered() {
      return entered;
    },
    release: () => gate.resolve(),
    abortRun() {},
    async runAgent(
      input: { messages: unknown[]; threadId: string; runId: string },
      handlers: { onEvent: (payload: { event: BaseEvent }) => void },
    ) {
      entered = true;
      await gate.promise;
      agent.messages = [
        ...input.messages,
        { id: `answer-${input.runId}`, role: "assistant", content: "ok" },
      ];
      for (const event of [
        ev("RUN_STARTED", { threadId: input.threadId, runId: input.runId }),
        ev("TEXT_MESSAGE_START", {
          messageId: `answer-${input.runId}`,
          role: "assistant",
        }),
        ev("TEXT_MESSAGE_CONTENT", {
          messageId: `answer-${input.runId}`,
          delta: "ok",
        }),
        ev("TEXT_MESSAGE_END", { messageId: `answer-${input.runId}` }),
        ev("RUN_FINISHED", { threadId: input.threadId, runId: input.runId }),
      ])
        handlers.onEvent({ event });
    },
  };
  return agent;
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
};

/** Start a run as `userId`; resolves to the completion promise. */
function start(
  runner: PostgresAgentRunner,
  agent: ReturnType<typeof blockedAgent>,
  threadId: string,
  runId: string,
  messages: { id: string; role: string; content: string }[],
  userId = "u1",
) {
  return requestUser.run({ id: userId, name: userId, role: "user" }, () =>
    lastValueFrom(
      runner
        .run({
          threadId,
          agent,
          input: { threadId, runId, messages, tools: [] },
        } as never)
        .pipe(toArray()),
    ),
  );
}

describe("pass10c no DB: liveRunId is set while the agent is blocked before RUN_STARTED, cleared after", () => {
  test("blocked before any event -> liveRunId = this run; finished -> undefined", async () => {
    const saved: { messages: { id: string; role: string }[] }[] = [];
    const store = {
      onThreadChange: () => {},
      loadRuns: async () => [],
      saveRun: async (run: { messages: { id: string; role: string }[] }) => {
        saved.push(run);
      },
      listAllThreads: async () => [],
      ownerOf: async () => "u1",
    } as unknown as LocalIntelligence;
    const runner = new PostgresAgentRunner(store);
    const agent = blockedAgent();
    const threadId = crypto.randomUUID();
    const done = start(runner, agent, threadId, "run-new", [
      { id: "m-new", role: "user", content: "bonjour" },
    ]);
    await waitFor(() => agent.entered);
    expect(liveRunId(threadId)).toBe("run-new");
    // Nothing is stored yet: a status read now would have no user message for this run.
    expect(saved).toHaveLength(0);
    agent.release();
    await done;
    await runner.ɵpersisted(threadId);
    expect(liveRunId(threadId)).toBeUndefined();
    const last = saved
      .at(-1)
      ?.messages.filter((message) => message.role === "user")
      .at(-1);
    expect(last?.id).toBe("m-new");
  });
});

const url = process.env.SYNELIA_TEST_DATABASE_URL?.trim()
  ? testDatabaseUrlFrom({
      TEST_DATABASE_URL: process.env.SYNELIA_TEST_DATABASE_URL,
    })
  : undefined;
const db = url ? describe : describe.skip;
const opened: LocalIntelligence[] = [];
afterAll(async () => {
  await Promise.all(opened.map((store) => store.close()));
});

/** The local GET /api/threads/:id body (app.ts), on the real store + runner registry. */
async function statusOf(
  store: LocalIntelligence,
  params: { threadId: string; userId: string },
) {
  try {
    const lastError = await store.lastRunError(params);
    const { lockedRunId, lostRunId } = await store.threadRunState(params);
    const lastUserMessageId = await store.lastUserMessageId(params);
    const activeRunId = liveRunId(params.threadId) ?? lockedRunId;
    return {
      known: true,
      lastError,
      activeRunId,
      lostRunId: activeRunId ? null : lostRunId,
      lastUserMessageId,
    };
  } catch (error) {
    if ((error as { status?: number }).status === 404)
      return { known: false, lastError: null, lastUserMessageId: null };
    throw error;
  }
}

db(
  "pass10c DB: GET /api/threads/:id during a run blocked before RUN_STARTED",
  () => {
    const store = url
      ? (() => {
          const opened1 = new LocalIntelligence(url as string);
          opened.push(opened1);
          return opened1;
        })()
      : (undefined as unknown as LocalIntelligence);

    test("brand-new thread, first run in flight: known:true + activeRunId, lastUserMessageId null; after: activeRunId null, lastUserMessageId = the message", async () => {
      const runner = new PostgresAgentRunner(store);
      const agent = blockedAgent();
      const threadId = crypto.randomUUID();
      const done = start(runner, agent, threadId, "run-first", [
        { id: "m-first", role: "user", content: "premier message" },
      ]);
      await waitFor(() => agent.entered);
      const during = await statusOf(store, { threadId, userId: "u1" });
      expect(during.known).toBe(true);
      expect(during.activeRunId).toBe("run-first");
      expect(during.lastUserMessageId).toBeNull();
      // Another person learns nothing about the thread (owner rule, 404 branch).
      const other = await statusOf(store, { threadId, userId: "someone-else" });
      expect(other).toEqual({
        known: false,
        lastError: null,
        lastUserMessageId: null,
      });
      agent.release();
      await done;
      await runner.ɵpersisted(threadId);
      const after = await statusOf(store, { threadId, userId: "u1" });
      expect(after.activeRunId).toBeNull();
      expect(after.lastUserMessageId).toBe("m-first");
    });

    test("thread with a prior run: during the new run lastUserMessageId is the OLD message (≠ new) and activeRunId is set; after, it is the new one", async () => {
      const runner = new PostgresAgentRunner(store);
      const threadId = crypto.randomUUID();
      const first = blockedAgent();
      first.release();
      await start(runner, first, threadId, "run-1", [
        { id: "m-old", role: "user", content: "ancien" },
      ]);
      await runner.ɵpersisted(threadId);

      const agent = blockedAgent();
      const done = start(runner, agent, threadId, "run-2", [
        { id: "m-old", role: "user", content: "ancien" },
        { id: "answer-run-1", role: "assistant", content: "ok" },
        { id: "m-new", role: "user", content: "nouveau" },
      ]);
      await waitFor(() => agent.entered);
      const during = await statusOf(store, { threadId, userId: "u1" });
      expect(during.known).toBe(true);
      expect(during.activeRunId).toBe("run-2");
      expect(during.lastUserMessageId).toBe("m-old");
      expect(during.lastUserMessageId).not.toBe("m-new");
      agent.release();
      await done;
      await runner.ɵpersisted(threadId);
      const after = await statusOf(store, { threadId, userId: "u1" });
      expect(after.activeRunId).toBeNull();
      expect(after.lastUserMessageId).toBe("m-new");
    });
  },
);
