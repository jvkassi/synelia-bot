/**
 * Synelia fork, gate "ouverture 5 utilisateurs" items 1, 2 and 4, against a real Postgres.
 * Run: SYNELIA_TEST_DATABASE_URL=postgres://... bun test tests/synelia-persistence.integration.test.ts
 * Skipped without the variable (CI without a database).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { isLockConflict } from "@openbot/toolkit/lease";
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
  const saveError = (
    threadId: string,
    events: unknown[],
    userId = "u1",
  ) =>
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
