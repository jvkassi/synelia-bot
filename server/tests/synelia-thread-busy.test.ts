import { expect, test } from "bun:test";
import {
  isThreadAlreadyRunning,
  threadBusyEvents,
} from "../src/persistence/postgres-runner";

test("the in-memory 'Thread already running' refusal streams RUN_STARTED then RUN_ERROR with code thread_busy", () => {
  expect(isThreadAlreadyRunning(new Error("Thread already running"))).toBe(
    true,
  );
  expect(isThreadAlreadyRunning(new Error("other"))).toBe(false);
  const events = threadBusyEvents({
    threadId: "t",
    input: { runId: "r" },
  } as never);
  expect(events.map((event) => event.type)).toEqual([
    "RUN_STARTED",
    "RUN_ERROR",
  ]);
  expect(events[1]).toMatchObject({
    code: "thread_busy",
    threadId: "t",
    runId: "r",
  });
});
