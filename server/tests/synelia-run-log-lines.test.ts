import { afterEach, beforeEach, expect, test } from "bun:test";
import { firstValueFrom, lastValueFrom, toArray } from "rxjs";
import type { LocalIntelligence } from "../src/persistence/local-intelligence";
import { PostgresAgentRunner } from "../src/persistence/postgres-runner";
import { logRunEvent } from "../src/synelia/request-log";

/**
 * Synelia fork: the run lifecycle lines the deploy drain reads (deploy/synelia/inflight-check.sh).
 * An accepted run writes `synelia_run_start` and later `run_timing` with the same runId; a POST /run
 * answered without a run writes `synelia_run_skip` with its reason and NO run_timing. No database:
 * the store is a stub, the agent a stub whose run we finish by hand.
 */
let lines: Record<string, unknown>[] = [];
const realLog = console.log;
beforeEach(() => {
  lines = [];
  console.log = (...args: unknown[]) => {
    const text = String(args[0] ?? "");
    const match = /^synelia_(?:run|timing) (\{.*\})$/.exec(text);
    if (match?.[1]) lines.push(JSON.parse(match[1]));
  };
});
afterEach(() => {
  console.log = realLog;
});

const store = {
  onThreadChange: () => {},
  loadRuns: async () => [],
  saveRun: async () => {},
  ownerOf: async () => null,
} as unknown as LocalIntelligence;

function agent(finish: Promise<void>) {
  return {
    agentId: "synelia-assistant",
    messages: [],
    async runAgent(input: { runId: string; threadId: string }, sub: { onEvent: (e: { event: unknown }) => void }) {
      sub.onEvent({ event: { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId } });
      await finish;
      sub.onEvent({ event: { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId } });
    },
  };
}
const request = (threadId: string, runId: string, messageId: string, finish: Promise<void>) =>
  ({
    threadId,
    agent: agent(finish),
    input: { threadId, runId, messages: [{ id: messageId, role: "user", content: "x" }], tools: [], context: [], state: {}, forwardedProps: {} },
  }) as never;
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

test("logRunEvent: ids and reason only, in the run_timing file format", () => {
  const line = JSON.parse(logRunEvent("synelia_run_skip", { reason: "thread_busy", threadId: "t", runId: "r", userId: "u" }, undefined));
  expect(Object.keys(line).sort()).toEqual(["kind", "reason", "runId", "threadId", "ts", "userId"]);
  expect(line.kind).toBe("synelia_run_skip");
});

test("accepted run: synelia_run_start, then run_timing with the same runId", async () => {
  const runner = new PostgresAgentRunner(store);
  const thread = crypto.randomUUID();
  await lastValueFrom(runner.run(request(thread, "run-1", "m-1", Promise.resolve())).pipe(toArray()));
  await flush();
  const mine = lines.filter((line) => line.threadId === thread);
  expect(mine.map((line) => line.kind)).toEqual(["synelia_run_start", "run_timing"]);
  expect(mine.every((line) => line.runId === "run-1")).toBe(true);
});

test("thread_busy: a second POST while a run is going writes synelia_run_skip and no run_timing", async () => {
  const runner = new PostgresAgentRunner(store);
  const thread = crypto.randomUUID();
  let release = () => {};
  const finish = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = lastValueFrom(runner.run(request(thread, "run-a", "m-a", finish)).pipe(toArray()));
  await flush();
  const busy = await lastValueFrom(runner.run(request(thread, "run-b", "m-b", finish)).pipe(toArray()));
  expect(busy.map((event) => (event as { type: string }).type)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
  release();
  await first;
  await flush();
  const forB = lines.filter((line) => line.runId === "run-b");
  expect(forB).toEqual([expect.objectContaining({ kind: "synelia_run_skip", reason: "thread_busy", threadId: thread })]);
});

test("already_answered: the idempotent resend writes synelia_run_skip and no run_timing", async () => {
  const runner = new PostgresAgentRunner(store);
  const thread = crypto.randomUUID();
  await lastValueFrom(runner.run(request(thread, "run-x", "m-x", Promise.resolve())).pipe(toArray()));
  await flush();
  const resend = await firstValueFrom(runner.run(request(thread, "run-y", "m-x", Promise.resolve())).pipe(toArray()));
  expect(resend.map((event) => (event as { type: string }).type)).toEqual(["RUN_STARTED", "RUN_FINISHED"]);
  await flush();
  const forY = lines.filter((line) => line.runId === "run-y");
  expect(forY).toEqual([expect.objectContaining({ kind: "synelia_run_skip", reason: "already_answered", threadId: thread })]);
});
