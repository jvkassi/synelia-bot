import { expect, test } from "bun:test";
import { Hono } from "hono";
import { THREAD_BUSY_BODY, threadBusyBody } from "../src/copilot";
import {
  isThreadAlreadyRunning,
  threadBusyEvents,
} from "../src/persistence/postgres-runner";

test("the runtime's 409 lock refusal leaves with code thread_busy in the HTTP body", async () => {
  const app = new Hono();
  app.use("/api/copilotkit/*", threadBusyBody);
  app.post("/api/copilotkit/agent/a/run", () =>
    Response.json({ error: "Thread lock denied" }, { status: 409 }),
  );
  const response = await app.request("/api/copilotkit/agent/a/run", {
    method: "POST",
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual(THREAD_BUSY_BODY);
});

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
