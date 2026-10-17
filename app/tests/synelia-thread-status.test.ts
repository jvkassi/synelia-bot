import { expect, test } from "bun:test";
import { threadStatusView } from "@/lib/copilot/synelia-model";

test("2a: a running server turn is exposed even when the replay ended on a partial Bot message", () => {
  const view = threadStatusView({ activeRunId: "run-1", interrupted: false }, false);
  expect(view.activeRunId).toBe("run-1");
  expect(view.interrupted).toBe(false);
});

test("lostRunId shows interrupted whatever the last message is", () => {
  expect(threadStatusView({ lostRunId: "run-2", interrupted: true }, false).interrupted).toBe(true);
  expect(threadStatusView({ lostRunId: "run-2", interrupted: true }, true).interrupted).toBe(true);
});

test("no run, person spoke last, no error: interrupted; Bot spoke last: nothing", () => {
  expect(threadStatusView({ interrupted: true }, true).interrupted).toBe(true);
  expect(threadStatusView({ interrupted: true }, false).interrupted).toBe(false);
});

test("a stored error wins over interrupted and is only shown after the person's message", () => {
  const body = { interrupted: true, lastError: { message: "boom" } };
  expect(threadStatusView(body, true)).toEqual({ error: "boom", activeRunId: null, interrupted: false });
  expect(threadStatusView(body, false).error).toBeNull();
});
