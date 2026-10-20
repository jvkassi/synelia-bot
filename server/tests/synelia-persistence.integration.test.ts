/**
 * Synelia fork, gate "ouverture 5 utilisateurs" items 1, 2 and 4, against a real Postgres.
 * Run: SYNELIA_TEST_DATABASE_URL=postgres://... bun test tests/synelia-persistence.integration.test.ts
 * Skipped without the variable (CI without a database).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { isLockConflict } from "@openbot/toolkit/lease";
import { lastValueFrom, timeout, toArray } from "rxjs";
import {
  LocalIntelligence,
  threadTitle,
} from "../src/persistence/local-intelligence";
import {
  PostgresAgentRunner,
  pickedModel,
} from "../src/persistence/postgres-runner";
import { resolveModel } from "../src/synelia/models";
import { testDatabaseUrlFrom } from "./support/database";

// Same guard as the upstream integration suite: refuses a missing protocol/database and the live
// openbot database, so this file can never run against the application DB.
const url = process.env.SYNELIA_TEST_DATABASE_URL?.trim()
  ? testDatabaseUrlFrom({
      TEST_DATABASE_URL: process.env.SYNELIA_TEST_DATABASE_URL,
    })
  : undefined;
const db = url ? describe : describe.skip;
const id = () => crypto.randomUUID();
/** Every pool this file opens, closed at the end so the suite does not run out of connections. */
const opened: LocalIntelligence[] = [];
const open = (options?: { expireLocksAtBoot?: boolean }) => {
  const store = new LocalIntelligence(url as string, options);
  opened.push(store);
  return store;
};
afterAll(async () => {
  await Promise.all(opened.map((store) => store.close()));
});

const list = {
  defaultModel: "router9:gemini/flash",
  models: [
    {
      id: "router9:gemini/flash",
      provider: "router9",
      model: "gemini/flash",
      available: true,
    },
    { id: "router9:glm", provider: "router9", model: "glm", available: true },
    {
      id: "openrouter:z-ai/glm",
      provider: "openrouter",
      model: "z-ai/glm",
      available: false,
    },
  ],
};

describe("resolveModel (gate 2: model stored = model that answered)", () => {
  test("allowlisted + available pick is kept", () => {
    expect(resolveModel("router9:glm", list)).toEqual({
      provider: "router9",
      model: "glm",
    });
  });
  test("unknown pick falls back to the default", () => {
    expect(resolveModel("evil:gpt-x", list)).toEqual({
      provider: "router9",
      model: "gemini/flash",
    });
  });
  test("pick on an unavailable provider falls back to the default", () => {
    expect(resolveModel("openrouter:z-ai/glm", list)).toEqual({
      provider: "router9",
      model: "gemini/flash",
    });
  });
  test("no pick → default; no list → the picked id, never an invented one", () => {
    expect(resolveModel(undefined, list).model).toBe("gemini/flash");
    // List unreachable at save time: the allowlisted pick is stored rather than NULL.
    expect(resolveModel("router9:glm", undefined)).toEqual({
      provider: "router9",
      model: "glm",
    });
    expect(resolveModel(undefined, undefined)).toEqual({});
  });
  test("pickedModel reads the raw context entry", () => {
    const request = {
      input: {
        context: [{ description: "Synelia model", value: '"router9:glm"' }],
      },
    };
    expect(pickedModel(request as never)).toBe("router9:glm");
  });
});

describe("threadTitle (G)", () => {
  test("strips markdown and cuts near 60 chars", () => {
    expect(
      threadTitle([{ role: "user", content: "## **Résume** `les MR` d'hier" }]),
    ).toBe("Résume les MR d'hier");
    const long =
      threadTitle([{ role: "user", content: "mot ".repeat(40) }]) ?? "";
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });
});

db("LocalIntelligence locks (gate 1)", () => {
  // describe.skip still runs this body: no DB url, no client.
  const store = url ? open() : (undefined as unknown as LocalIntelligence);
  const base = { userId: "u1", agentId: "a" };

  test("acquire with the same runId twice succeeds; another runId gets 409", async () => {
    const threadId = id();
    const runId = id();
    await store.ɵacquireThreadLock({ ...base, threadId, runId });
    await store.ɵacquireThreadLock({ ...base, threadId, runId });
    const other = await store
      .ɵacquireThreadLock({ ...base, threadId, runId: id() })
      .catch((e) => e);
    expect(isLockConflict(other)).toBe(true);
  });

  test("renew on a lost lock throws a lock conflict (keepLease stops the turn)", async () => {
    const threadId = id();
    const runId = id();
    await store.ɵacquireThreadLock({ ...base, threadId, runId });
    await store.ɵrenewThreadLock({ threadId, runId, ttlSeconds: 60 });
    await store.ɵcleanupThreadLock({ threadId, runId });
    const lost = await store
      .ɵrenewThreadLock({ threadId, runId, ttlSeconds: 60 })
      .catch((e) => e);
    expect(isLockConflict(lost)).toBe(true);
  });
});

db("boot expires stale locks, row kept, acquire works again", () => {
  test("a lock held before boot is expired (interrupted), not deleted; a new run can lock", async () => {
    const before = open({
      expireLocksAtBoot: true,
    });
    const threadId = id();
    const runId = id();
    await before.getOrCreateThread({ threadId, userId: "u1", agentId: "a" });
    await before.ɵacquireThreadLock({
      threadId,
      runId,
      userId: "u1",
      agentId: "a",
    });
    expect(
      (await before.threadRunState({ threadId, userId: "u1" })).lockedRunId,
    ).toBe(runId);
    const booted = open({
      expireLocksAtBoot: true,
    }); // fresh process: ready() runs the boot step
    await booted.ready();
    expect(
      (await booted.threadRunState({ threadId, userId: "u1" })).lockedRunId,
    ).toBeNull();
    // Expired lock, no stored run for it: the turn is reported lost.
    expect(
      (await booted.threadRunState({ threadId, userId: "u1" })).lostRunId,
    ).toBe(runId);
    await booted.ɵacquireThreadLock({
      threadId,
      runId: id(),
      userId: "u1",
      agentId: "a",
    });
  });
});

db("runner index follows rename / archive / delete (gate 4)", () => {
  // describe.skip still runs this body: no DB url, no client.
  const store = url ? open() : (undefined as unknown as LocalIntelligence);
  const runner = new PostgresAgentRunner(store);

  test("index updated immediately, not at the next run", async () => {
    const threadId = id();
    await store.getOrCreateThread({ threadId, userId: "u1", agentId: "a" });
    await store.updateThread({
      threadId,
      userId: "u1",
      agentId: "a",
      updates: { name: "Renommé" },
    });
    expect(runner.indexed(threadId)?.name).toBe("Renommé");
    await store.archiveThread({ threadId, userId: "u1", agentId: "a" });
    expect(runner.indexed(threadId)?.archived).toBe(true);
    await store.deleteThread({ threadId, userId: "u1" });
    expect(runner.indexed(threadId)).toBeUndefined();
  });

  test("other user: rename/delete answer 404", async () => {
    const threadId = id();
    await store.getOrCreateThread({ threadId, userId: "u1", agentId: "a" });
    const rename = await store
      .updateThread({
        threadId,
        userId: "u2",
        agentId: "a",
        updates: { name: "x" },
      })
      .catch((e) => e);
    expect(rename.status).toBe(404);
    expect(
      (await store.deleteThread({ threadId, userId: "u2" }).catch((e) => e))
        .status,
    ).toBe(404);
  });

  test("title set once from the first run, failed runs and later runs never rewrite it, rename wins", async () => {
    const threadId = id();
    const run = (status: string, text: string) =>
      store.saveRun({
        runId: id(),
        threadId,
        agentId: "a",
        parentRunId: null,
        events: [],
        createdAt: Date.now(),
        messages: [{ id: id(), role: "user", content: text }],
        status,
        userId: "u1",
      } as never);
    await run("error", "**échec**");
    expect(runner.indexed(threadId)?.name ?? null).toBeNull();
    await run("done", "# Premier message");
    expect(runner.indexed(threadId)?.name).toBe("Premier message");
    await run("done", "Autre");
    expect(runner.indexed(threadId)?.name).toBe("Premier message");
    await store.updateThread({
      threadId,
      userId: "u1",
      agentId: "a",
      updates: { name: "Mon titre" },
    });
    await run("done", "Encore");
    expect(runner.indexed(threadId)?.name).toBe("Mon titre");
  });
});

db("message_ids + per-thread badge map (I)", () => {
  // describe.skip still runs this body: no DB url, no client.
  const store = url ? open() : (undefined as unknown as LocalIntelligence);
  test("START and CHUNK ids stored; map has the last assistant message of each run; other user 404", async () => {
    const threadId = id();
    const save = (events: unknown[], model: string) =>
      store.saveRun({
        runId: id(),
        threadId,
        agentId: "a",
        parentRunId: null,
        createdAt: Date.now(),
        messages: [],
        events,
        status: "done",
        userId: "u1",
        provider: "router9",
        model,
      } as never);
    await save(
      [
        { type: "TEXT_MESSAGE_START", messageId: "m1" },
        { type: "TEXT_MESSAGE_CHUNK", messageId: "m2" },
      ],
      "glm",
    );
    await save([{ type: "TEXT_MESSAGE_CHUNK", messageId: "m3" }], "flash");
    expect(await store.threadMessageModels({ threadId, userId: "u1" })).toEqual(
      {
        m2: { provider: "router9", model: "glm" },
        m3: { provider: "router9", model: "flash" },
      },
    );
    expect(
      (await store.messageModel({ messageId: "m3", userId: "u1" }))?.model,
    ).toBe("flash");
    expect(
      (
        await store
          .threadMessageModels({ threadId, userId: "u2" })
          .catch((e) => e)
      ).status,
    ).toBe(404);
  });
});

describe("hidden QA model (admin only)", () => {
  test("listed for admins only; recognised as hidden", async () => {
    const { visibleModels, isHiddenModel } = await import(
      "../src/synelia/models"
    );
    const withTest = {
      ...list,
      models: [
        ...list.models,
        {
          id: "synelia-test:always-fails",
          provider: "synelia-test",
          model: "always-fails",
          hidden: true,
        },
      ],
    };
    expect(
      visibleModels(withTest, false).models.some((m) =>
        m.id.startsWith("synelia-test"),
      ),
    ).toBe(false);
    expect(
      visibleModels(withTest, true).models.some((m) =>
        m.id.startsWith("synelia-test"),
      ),
    ).toBe(true);
    expect(isHiddenModel("synelia-test:always-fails", withTest)).toBe(true);
    expect(isHiddenModel("router9:glm", withTest)).toBe(false);
    // Fail closed: list unreachable and no cache -> still hidden.
    expect(isHiddenModel("synelia-test:always-fails", undefined)).toBe(true);
    expect(isHiddenModel("synelia-test:anything", undefined)).toBe(true);
  });
});

db("lastRunError carries the stable code (reload after a refusal)", () => {
  // describe.skip still runs this body: no DB url, no client.
  const store = url ? open() : (undefined as unknown as LocalIntelligence);
  const saveError = (threadId: string, events: unknown[], userId = "u1") =>
    store.saveRun({
      runId: id(),
      threadId,
      agentId: "a",
      parentRunId: null,
      events,
      createdAt: Date.now(),
      messages: [{ id: id(), role: "user", content: "demande" }],
      status: "error",
      provider: "router9",
      model: "cc/claude-sonnet-5-5",
      userId,
    } as never);

  test("a persisted provider_refusal run returns message AND code after reload", async () => {
    const threadId = id();
    // What adjustPersistedRun writes for a silent refusal: RUN_ERROR, no RUN_FINISHED.
    await saveError(threadId, [
      { type: "RUN_STARTED", threadId, runId: "x" },
      {
        type: "RUN_ERROR",
        threadId,
        runId: "x",
        message: "content_filter",
        code: "provider_refusal",
      },
    ]);
    const last = await store.lastRunError({ threadId, userId: "u1" });
    expect(last?.code).toBe("provider_refusal");
    expect(last?.message).toBe("content_filter");
    expect(last?.provider).toBe("router9");
  });

  test("a stall run returns the watchdog's code", async () => {
    const threadId = id();
    await saveError(threadId, [
      { type: "RUN_STARTED", threadId, runId: "x" },
      {
        type: "RUN_ERROR",
        threadId,
        runId: "x",
        message: "Bot stopped responding. Nothing arrived from it for a minute",
        code: "AGENT_STREAM_STALLED",
      },
    ]);
    const last = await store.lastRunError({ threadId, userId: "u1" });
    expect(last?.code).toBe("AGENT_STREAM_STALLED");
  });

  test("another user cannot read the error", async () => {
    const threadId = id();
    await saveError(threadId, [
      {
        type: "RUN_ERROR",
        threadId,
        runId: "x",
        message: "content_filter",
        code: "provider_refusal",
      },
    ]);
    expect(
      await store
        .lastRunError({ threadId, userId: "someone-else" })
        .then(() => "ok")
        .catch((error) => (error as { status?: number }).status),
    ).toBe(404);
  });
  test("retry after a refusal: two runs stored, the retry snapshot has exactly one user message", async () => {
    const threadId = id();
    const userMessageId = id();
    // Run 1: the refused run (status error), the person's message is the only user message.
    await store.saveRun({
      runId: id(),
      threadId,
      agentId: "a",
      parentRunId: null,
      events: [
        { type: "RUN_STARTED", threadId, runId: "r1" },
        {
          type: "RUN_ERROR",
          threadId,
          runId: "r1",
          message: "content_filter",
          code: "provider_refusal",
        },
      ],
      createdAt: Date.now(),
      messages: [{ id: userMessageId, role: "user", content: "demande" }],
      status: "error",
      userId: "u1",
    } as never);
    // Retry: same user message id (the front re-runs on the existing message, never a new one), now
    // answered. The snapshot must carry that one user message once, plus the assistant reply.
    await store.saveRun({
      runId: id(),
      threadId,
      agentId: "a",
      parentRunId: null,
      events: [
        { type: "RUN_STARTED", threadId, runId: "r2" },
        { type: "TEXT_MESSAGE_CONTENT", delta: "voici" },
        { type: "RUN_FINISHED", threadId, runId: "r2" },
      ],
      createdAt: Date.now() + 1,
      messages: [
        { id: userMessageId, role: "user", content: "demande" },
        { id: id(), role: "assistant", content: "voici" },
      ],
      status: "done",
      userId: "u1",
    } as never);

    const runs = await store.loadRuns(threadId);
    expect(runs.length).toBe(2);
    const retry = runs[1];
    const users = (retry?.messages ?? []).filter(
      (m) => (m as { role?: string }).role === "user",
    );
    expect(users.length).toBe(1);
    expect((users[0] as { id?: string }).id).toBe(userMessageId);
    // And the latest snapshot the thread exposes is the retry's, not a merge that duplicated it.
    const latest = await store.getThreadMessages({ threadId, userId: "u1" });
    expect(
      latest.messages.filter((m) => (m as { role?: string }).role === "user")
        .length,
    ).toBe(1);
  });
});

db("getThreadMessages / getThreadEvents go through replayEvents (item 3)", () => {
  // describe.skip still runs this body: no DB url, no client.
  const store = url ? open() : (undefined as unknown as LocalIntelligence);

  test("a provider_refusal run's assistant message is removed from the snapshot and its text from the events", async () => {
    const threadId = id();
    const userMessageId = id();
    const assistantMessageId = id();
    await store.saveRun({
      runId: id(),
      threadId,
      agentId: "a",
      parentRunId: null,
      events: [
        { type: "RUN_STARTED", threadId, runId: "r1" },
        {
          type: "TEXT_MESSAGE_START",
          messageId: assistantMessageId,
          role: "assistant",
        },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: assistantMessageId,
          delta: "This request was blocked under policy.",
        },
        { type: "TEXT_MESSAGE_END", messageId: assistantMessageId },
        {
          type: "RUN_ERROR",
          threadId,
          runId: "r1",
          message: "content_filter",
          code: "provider_refusal",
        },
      ],
      createdAt: Date.now(),
      // The snapshot the runtime stored carries BOTH messages (the model wrote the refusal as text).
      messages: [
        { id: userMessageId, role: "user", content: "demande" },
        {
          id: assistantMessageId,
          role: "assistant",
          content: "This request was blocked under policy.",
        },
      ],
      status: "error",
      userId: "u1",
    } as never);

    // getThreadMessages: the refusal assistant message is gone, the user's own message stays.
    const { messages } = await store.getThreadMessages({ threadId, userId: "u1" });
    expect(messages.map((m) => (m as { id?: string }).id)).toEqual([
      userMessageId,
    ]);
    expect(
      messages.some((m) => (m as { role?: string }).role === "assistant"),
    ).toBe(false);

    // getThreadEvents: no assistant text survives (the notice comes from the RUN_ERROR code).
    const { events } = await store.getThreadEvents({ threadId });
    expect(
      events.some((e) => (e as { type?: string }).type?.startsWith("TEXT_MESSAGE")),
    ).toBe(false);
    expect(
      events.some((e) => (e as { type?: string }).type === "RUN_ERROR"),
    ).toBe(true);
  });

  test("a superseded error run's text is dropped but the retry's answer and user message survive", async () => {
    const threadId = id();
    const userMessageId = id();
    const brokenId = id();
    const answerId = id();
    await store.saveRun({
      runId: id(),
      threadId,
      agentId: "a",
      parentRunId: null,
      events: [
        { type: "RUN_STARTED", threadId, runId: "r1" },
        { type: "TEXT_MESSAGE_START", messageId: brokenId, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: brokenId, delta: "partial" },
        {
          type: "RUN_ERROR",
          threadId,
          runId: "r1",
          message: "boom",
          code: "provider_unavailable",
        },
      ],
      createdAt: Date.now(),
      messages: [{ id: userMessageId, role: "user", content: "demande" }],
      status: "error",
      userId: "u1",
    } as never);
    await store.saveRun({
      runId: id(),
      threadId,
      agentId: "a",
      parentRunId: null,
      events: [
        { type: "RUN_STARTED", threadId, runId: "r2" },
        { type: "TEXT_MESSAGE_START", messageId: answerId, role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: answerId, delta: "la vraie réponse" },
        { type: "TEXT_MESSAGE_END", messageId: answerId },
        { type: "RUN_FINISHED", threadId, runId: "r2" },
      ],
      createdAt: Date.now() + 1,
      messages: [
        { id: userMessageId, role: "user", content: "demande" },
        { id: answerId, role: "assistant", content: "la vraie réponse" },
      ],
      status: "done",
      userId: "u1",
    } as never);

    const { messages } = await store.getThreadMessages({ threadId, userId: "u1" });
    expect(messages.map((m) => (m as { id?: string }).id)).toEqual([
      userMessageId,
      answerId,
    ]);
    const { events } = await store.getThreadEvents({ threadId });
    const text = events
      .filter((e) => (e as { type?: string }).type === "TEXT_MESSAGE_CONTENT")
      .map((e) => (e as { delta?: string }).delta ?? "")
      .join(" ");
    expect(text).toContain("vraie réponse");
    expect(text).not.toContain("partial");
  });
});

db(
  "connect replay: single rule (retryable + suppression), full chain through persistence",
  () => {
    // describe.skip still runs this body: no DB url, no client.
    const store = url ? open() : (undefined as unknown as LocalIntelligence);
    // A FRESH runner = the reload case: nothing is in memory, so connect() must hydrate from Postgres
    // and apply the single replay rule (replayEvents) from the stored events.
    const runner = url
      ? new PostgresAgentRunner(store)
      : (undefined as unknown as PostgresAgentRunner);

    const replay = async (threadId: string) =>
      (await lastValueFrom(
        runner.connect({ threadId }).pipe(timeout(5000), toArray()),
      )) as { type: string; metadata?: { retryable?: boolean } }[];
    const runError = (
      events: { type: string; metadata?: { retryable?: boolean } }[],
    ) => events.find((event) => event.type === "RUN_ERROR");

    test("full chain: RUN_ERROR with report_refusal -> persisted -> fresh connect replay is retryable:false", async () => {
      const threadId = id();
      const runId = id();
      await store.saveRun({
        runId,
        threadId,
        agentId: "a",
        parentRunId: null,
        events: [
          { type: "RUN_STARTED", threadId, runId },
          {
            type: "TOOL_CALL_START",
            toolCallId: "c1",
            toolCallName: "report_refusal",
          },
          { type: "TOOL_CALL_END", toolCallId: "c1" },
          {
            type: "RUN_ERROR",
            threadId,
            runId,
            message: "content_filter",
            code: "provider_refusal",
          },
        ],
        createdAt: Date.now(),
        messages: [{ id: id(), role: "user", content: "demande" }],
        status: "error",
        userId: "u1",
      } as never);

      const error = runError(await replay(threadId));
      expect(error?.metadata?.retryable).toBe(false);
    });

    test("legacy run: stored RUN_ERROR WITHOUT metadata, containing report_refusal, replays retryable:false", async () => {
      const threadId = id();
      const runId = id();
      await store.saveRun({
        runId,
        threadId,
        agentId: "a",
        parentRunId: null,
        // No metadata anywhere (persisted before this hash); the value is derived from the tool call.
        events: [
          { type: "RUN_STARTED", threadId, runId },
          {
            type: "TOOL_CALL_START",
            toolCallId: "c1",
            toolCallName: "report_refusal",
          },
          { type: "RUN_ERROR", threadId, runId, message: "stopped" },
        ],
        createdAt: Date.now(),
        messages: [{ id: id(), role: "user", content: "demande" }],
        status: "error",
        userId: "u1",
      } as never);

      const error = runError(await replay(threadId));
      expect(error?.metadata?.retryable).toBe(false);
    });

    test("a refusal with no effectful tool call replays as retryable:true", async () => {
      const threadId = id();
      const runId = id();
      await store.saveRun({
        runId,
        threadId,
        agentId: "a",
        parentRunId: null,
        events: [
          { type: "RUN_STARTED", threadId, runId },
          {
            type: "RUN_ERROR",
            threadId,
            runId,
            message: "content_filter",
            code: "provider_refusal",
          },
        ],
        createdAt: Date.now(),
        messages: [{ id: id(), role: "user", content: "demande" }],
        status: "error",
        userId: "u1",
      } as never);

      const error = runError(await replay(threadId));
      expect(error?.metadata?.retryable).toBe(true);
    });

    test("a provider_refusal run's English text is dropped on replay (notice comes from the code)", async () => {
      const threadId = id();
      const runId = id();
      await store.saveRun({
        runId,
        threadId,
        agentId: "a",
        parentRunId: null,
        events: [
          { type: "RUN_STARTED", threadId, runId },
          { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "m1",
            delta: "This request was blocked under policy.",
          },
          { type: "TEXT_MESSAGE_END", messageId: "m1" },
          {
            type: "RUN_ERROR",
            threadId,
            runId,
            message: "content_filter",
            code: "provider_refusal",
          },
        ],
        createdAt: Date.now(),
        messages: [{ id: id(), role: "user", content: "demande" }],
        status: "error",
        userId: "u1",
      } as never);

      const events = await replay(threadId);
      expect(
        events.some((event) => event.type.startsWith("TEXT_MESSAGE")),
      ).toBe(false);
      expect(runError(events)?.metadata?.retryable).toBe(true);
    });

    test("a SUPERSEDED error run (retried and answered) drops its text; the answer's text survives", async () => {
      const threadId = id();
      const userMessageId = id();
      const run1 = id();
      const run2 = id();
      // Run 1: a plain failure (not a refusal) with streamed partial text, later superseded.
      await store.saveRun({
        runId: run1,
        threadId,
        agentId: "a",
        parentRunId: null,
        events: [
          { type: "RUN_STARTED", threadId, runId: run1 },
          { type: "TEXT_MESSAGE_START", messageId: "p1", role: "assistant" },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "p1",
            delta: "partial that broke",
          },
          {
            type: "RUN_ERROR",
            threadId,
            runId: run1,
            message: "boom",
            code: "provider_unavailable",
          },
        ],
        createdAt: Date.now(),
        messages: [{ id: userMessageId, role: "user", content: "demande" }],
        status: "error",
        userId: "u1",
      } as never);
      // Run 2: the retry answered cleanly.
      await store.saveRun({
        runId: run2,
        threadId,
        agentId: "a",
        parentRunId: null,
        events: [
          { type: "RUN_STARTED", threadId, runId: run2 },
          { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "a1",
            delta: "voici la vraie réponse",
          },
          { type: "TEXT_MESSAGE_END", messageId: "a1" },
          { type: "RUN_FINISHED", threadId, runId: run2 },
        ],
        createdAt: Date.now() + 1,
        messages: [
          { id: userMessageId, role: "user", content: "demande" },
          { id: id(), role: "assistant", content: "voici la vraie réponse" },
        ],
        status: "done",
        userId: "u1",
      } as never);

      const events = await replay(threadId);
      const text = events
        .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
        .map((event) => (event as { delta?: string }).delta ?? "")
        .join(" ");
      expect(text).toContain("vraie réponse");
      expect(text).not.toContain("partial that broke");
    });

    test("usage0-converted run: text hidden on replay AND reason 'usage0' countable from the DB", async () => {
      const threadId = id();
      const runId = id();
      // What adjustPersistedRun writes when the usage0 rule is ACTIVE: text kept, RUN_FINISHED
      // replaced by a provider_refusal RUN_ERROR carrying metadata.reason "usage0".
      await store.saveRun({
        runId,
        threadId,
        agentId: "a",
        parentRunId: null,
        events: [
          { type: "RUN_STARTED", threadId, runId },
          { type: "TEXT_MESSAGE_START", messageId: "m1", role: "assistant" },
          {
            type: "TEXT_MESSAGE_CONTENT",
            messageId: "m1",
            delta: "This request was blocked under policy.",
          },
          { type: "TEXT_MESSAGE_END", messageId: "m1" },
          {
            type: "RUN_ERROR",
            threadId,
            runId,
            message: "content_filter",
            code: "provider_refusal",
            metadata: { reason: "usage0" },
          },
        ],
        createdAt: Date.now(),
        messages: [{ id: id(), role: "user", content: "demande" }],
        status: "error",
        userId: "u1",
      } as never);

      const events = await replay(threadId);
      expect(
        events.some((event) => event.type.startsWith("TEXT_MESSAGE")),
      ).toBe(false);
      expect(runError(events)?.metadata?.retryable).toBe(true);

      // DB-countable: the reason survives in the stored events, so a weekly script can count it
      // without parsing docker logs.
      const runs = await store.loadRuns(threadId);
      const stored = (runs[0]?.events ?? []).find(
        (event) => (event as { type?: string }).type === "RUN_ERROR",
      ) as { code?: string; metadata?: { reason?: string } } | undefined;
      expect(stored?.code).toBe("provider_refusal");
      expect(stored?.metadata?.reason).toBe("usage0");
    });
  },
);

db("lastUserMessageId (pass10b: cut before RUN_STARTED)", () => {
  const store = url ? open() : (undefined as unknown as LocalIntelligence);
  const saveOk = (
    threadId: string,
    messages: { id: string; role: string; content: string }[],
    userId = "u1",
  ) =>
    store.saveRun({
      runId: id(),
      threadId,
      agentId: "a",
      parentRunId: null,
      events: [
        { type: "RUN_STARTED", threadId, runId: "x" },
        { type: "RUN_FINISHED", threadId, runId: "x" },
      ],
      createdAt: Date.now(),
      messages,
      status: "finished",
      provider: "router9",
      model: "gemini/flash",
      userId,
    } as never);

  test("owner: returns the id of the last stored user message, not an assistant one", async () => {
    const threadId = id();
    const first = id();
    const second = id();
    await saveOk(threadId, [{ id: first, role: "user", content: "un" }]);
    await saveOk(threadId, [
      { id: first, role: "user", content: "un" },
      { id: id(), role: "assistant", content: "réponse" },
      { id: second, role: "user", content: "deux" },
      { id: id(), role: "assistant", content: "réponse 2" },
    ]);
    expect(await store.lastUserMessageId({ threadId, userId: "u1" })).toBe(
      second,
    );
  });

  test("another user: 404, same owner rule as getThreadMessages", async () => {
    const threadId = id();
    await saveOk(threadId, [{ id: id(), role: "user", content: "secret" }]);
    expect(
      await store
        .lastUserMessageId({ threadId, userId: "someone-else" })
        .then(() => "ok")
        .catch((error) => (error as { status?: number }).status),
    ).toBe(404);
  });

  test("empty / never-run thread: null", async () => {
    expect(
      await store.lastUserMessageId({ threadId: id(), userId: "u1" }),
    ).toBeNull();
  });
});
