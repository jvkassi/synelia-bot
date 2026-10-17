import { expect, test } from "bun:test";
import { threadStatusView } from "@/lib/copilot/synelia-model";

test("2a: F5 mid-run, last message is the PARTIAL assistant text: activeRunId is exposed", () => {
  const view = threadStatusView(
    { activeRunId: "run-1", lostRunId: null },
    false,
  );
  expect(view.activeRunId).toBe("run-1");
  expect(view.interrupted).toBe(false);
  expect(view.error).toBeNull();
});

test("idle normal thread (no run, nothing lost): no interrupted banner, whoever spoke last", () => {
  for (const endsOnUser of [true, false]) {
    const view = threadStatusView(
      { activeRunId: null, lostRunId: null, lastError: null },
      endsOnUser,
    );
    expect(view).toEqual({
      error: null,
      activeRunId: null,
      interrupted: false,
    });
  }
});

test("lostRunId shows interrupted whatever the last message is; an active run hides it", () => {
  expect(threadStatusView({ lostRunId: "run-2" }, false).interrupted).toBe(
    true,
  );
  expect(threadStatusView({ lostRunId: "run-2" }, true).interrupted).toBe(true);
  expect(
    threadStatusView({ lostRunId: "run-2", activeRunId: "run-3" }, true)
      .interrupted,
  ).toBe(false);
});

test("a stored error is only shown after the person's message", () => {
  const body = { lastError: { message: "boom" } };
  expect(threadStatusView(body, true).error).toBe("boom");
  expect(threadStatusView(body, false).error).toBeNull();
});

import { serverRunStep } from "@/lib/copilot/synelia-model";

test("2a: F5 mid-run -> indicator while the server runs, then ONE replay when it ends", () => {
  let state = serverRunStep(false, "run-1", false);
  expect(state).toEqual({ sawActive: true, indicator: true, replay: false });
  state = serverRunStep(state.sawActive, "run-1", false); // poll, still running
  expect(state.indicator).toBe(true);
  state = serverRunStep(state.sawActive, null, false); // run ended
  expect(state).toEqual({ sawActive: false, indicator: false, replay: true });
  expect(serverRunStep(state.sawActive, null, false).replay).toBe(false); // only once
});

test("a run this page streams itself draws no second indicator and no replay", () => {
  expect(serverRunStep(false, "run-1", true).indicator).toBe(false);
  expect(serverRunStep(true, null, true).replay).toBe(false);
});

test("idle thread: nothing", () => {
  expect(serverRunStep(false, null, false)).toEqual({
    sawActive: false,
    indicator: false,
    replay: false,
  });
});
