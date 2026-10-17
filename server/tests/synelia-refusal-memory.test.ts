/**
 * Synelia fork (item 1, BLOCKING): on the SAME in-process runner, a silent provider refusal must
 * leave the IN-MEMORY run holding the ADJUSTED events (provider_refusal RUN_ERROR, text hidden on
 * replay), not the raw English text + RUN_FINISHED. Otherwise connect() replays the English refusal
 * and isAlreadyAnswered treats the turn as answered, so a resend of the same message returns an empty
 * finished run instead of running the model again.
 *
 * NO DATABASE: a fake LocalIntelligence (loadRuns -> [], saveRun -> noop) stands in for Postgres, so
 * this runs in the default `cd server && bun test` with no DB vars and is never skipped. Everything
 * else (the in-memory global store, connect/replay, isAlreadyAnswered) is the real runner.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { lastValueFrom, toArray } from "rxjs";
import type { LocalIntelligence } from "../src/persistence/local-intelligence";
import { PostgresAgentRunner } from "../src/persistence/postgres-runner";
import type { SyneliaModelList } from "../src/synelia/models";

/** A LocalIntelligence that touches no database: enough of the surface the runner calls. */
function fakeStore(): LocalIntelligence {
  return {
    onThreadChange: () => {},
    loadRuns: async () => [],
    saveRun: async () => {},
    listAllThreads: async () => [],
    ownerOf: async () => undefined,
  } as unknown as LocalIntelligence;
}

/** A scripted agent: each run plays one event list, and records how many times it was invoked. */
function scriptedAgent(scripts: BaseEvent[][]) {
  let call = 0;
  const agent = {
    agentId: "a",
    messages: [] as unknown[],
    get calls() {
      return call;
    },
    abortRun() {},
    async runAgent(
      _input: unknown,
      handlers: { onEvent: (payload: { event: BaseEvent }) => void },
    ) {
      const events = scripts[call] ?? [];
      call += 1;
      for (const event of events) handlers.onEvent({ event });
    },
  };
  return agent;
}

const ctxEntry = (value: string) => ({
  description: "Synelia model",
  value: `"${value}"`,
});

const USAGE0_ENV = "SYNELIA_REFUSAL_USAGE0_MODELS";
const previousEnv = process.env[USAGE0_ENV];
afterEach(() => {
  if (previousEnv === undefined) delete process.env[USAGE0_ENV];
  else process.env[USAGE0_ENV] = previousEnv;
});

const list: SyneliaModelList = {
  defaultModel: "router9:gemini/flash",
  models: [
    {
      id: "router9:gemini/flash",
      provider: "router9",
      model: "gemini/flash",
      available: true,
    },
    {
      id: "router9:cc/claude-sonnet-5-5",
      provider: "router9",
      model: "cc/claude-sonnet-5-5",
      available: true,
    },
  ],
} as unknown as SyneliaModelList;

const ev = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, ...extra }) as unknown as BaseEvent;

type Any = { type: string; code?: string; metadata?: { reason?: string } };
const collect = async (obs: ReturnType<PostgresAgentRunner["connect"]>) =>
  (await lastValueFrom(obs.pipe(toArray()))) as Any[];

describe("item 1: in-memory run holds the adjusted events (refusal -> connect -> resend)", () => {
  for (const shape of ["empty_finish", "usage0"] as const) {
    test(`${shape}: connect replays provider_refusal (text hidden) and a resend runs the model again`, async () => {
      if (shape === "usage0")
        process.env[USAGE0_ENV] = "router9:cc/claude-sonnet-5-5";

      const threadId = `t-${shape}`;
      const userMessageId = `m-${shape}`;
      const picked =
        shape === "usage0" ? "router9:cc/claude-sonnet-5-5" : undefined;

      // Run 1: the refusal. empty_finish = finished with nothing; usage0 = text + usage 0.
      const refusal: BaseEvent[] =
        shape === "empty_finish"
          ? [ev("RUN_STARTED"), ev("RUN_FINISHED")]
          : [
              ev("RUN_STARTED"),
              ev("TEXT_MESSAGE_START", { messageId: "r1", role: "assistant" }),
              ev("TEXT_MESSAGE_CONTENT", {
                messageId: "r1",
                delta: "This request was blocked under policy.",
              }),
              ev("TEXT_MESSAGE_END", { messageId: "r1" }),
              ev("RUN_FINISHED", { usage: [{ outputTokens: 0, inputTokens: 9 }] }),
            ];
      // Run 2 (the resend): a clean answer, proving the model was called again.
      const answer: BaseEvent[] = [
        ev("RUN_STARTED"),
        ev("TEXT_MESSAGE_START", { messageId: "a1", role: "assistant" }),
        ev("TEXT_MESSAGE_CONTENT", { messageId: "a1", delta: "voici" }),
        ev("TEXT_MESSAGE_END", { messageId: "a1" }),
        ev("RUN_FINISHED", { usage: [{ outputTokens: 7, inputTokens: 9 }] }),
      ];
      const agent = scriptedAgent([refusal, answer]);

      const runner = new PostgresAgentRunner(fakeStore(), async () => list);
      const request = {
        threadId,
        agent,
        input: {
          runId: "run-1",
          messages: [{ id: userMessageId, role: "user", content: "demande" }],
          tools: [],
          ...(picked ? { context: [ctxEntry(picked)] } : {}),
        },
      };

      // Run 1 to completion, then wait for persistence (the in-memory adjust) to settle.
      await lastValueFrom(
        runner.run(request as never).pipe(toArray()),
      );
      await runner.ɵpersisted(threadId);
      expect(agent.calls).toBe(1);

      // Reload in THIS process: connect() replays from memory. The refusal becomes a RUN_ERROR
      // provider_refusal and the English text is gone.
      const replay = await collect(runner.connect({ threadId } as never));
      const error = replay.find((e) => e.type === "RUN_ERROR");
      expect(error?.code).toBe("provider_refusal");
      expect(error?.metadata?.reason).toBe(shape);
      expect(replay.some((e) => e.type === "RUN_FINISHED")).toBe(false);
      expect(replay.some((e) => e.type.startsWith("TEXT_MESSAGE"))).toBe(false);

      // Resend the SAME message id: isAlreadyAnswered must be false (the run carries a RUN_ERROR), so
      // the model runs again rather than returning an empty finished run.
      const resend = {
        threadId,
        agent,
        input: {
          runId: "run-2",
          messages: [{ id: userMessageId, role: "user", content: "demande" }],
          tools: [],
          ...(picked ? { context: [ctxEntry(picked)] } : {}),
        },
      };
      await lastValueFrom(runner.run(resend as never).pipe(toArray()));
      await runner.ɵpersisted(threadId);
      expect(agent.calls).toBe(2);
    });
  }
});
