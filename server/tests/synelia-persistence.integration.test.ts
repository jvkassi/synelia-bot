/**
 * Synelia fork, gate "ouverture 5 utilisateurs" items 1, 2 and 4, against a real Postgres.
 * Run: SYNELIA_TEST_DATABASE_URL=postgres://... bun test tests/synelia-persistence.integration.test.ts
 * Skipped without the variable (CI without a database).
 */
import { describe, expect, test } from "bun:test";
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

const url = process.env.SYNELIA_TEST_DATABASE_URL;
const db = url ? describe : describe.skip;
const id = () => crypto.randomUUID();

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
  test("no pick → default; no list → nothing claimed", () => {
    expect(resolveModel(undefined, list).model).toBe("gemini/flash");
    expect(resolveModel("router9:glm", undefined)).toEqual({});
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
  const store = new LocalIntelligence(url as string);
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

db("runner index follows rename / archive / delete (gate 4)", () => {
  const store = new LocalIntelligence(url as string);
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
  const store = new LocalIntelligence(url as string);
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
