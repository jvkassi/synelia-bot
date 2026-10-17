/**
 * Synelia fork: the bridge-side decision that turns a silent provider refusal into a persisted
 * RUN_ERROR, and gives every RUN_ERROR a stable code. Pure, so no database here (the reload is
 * covered in synelia-persistence.integration.test.ts).
 */
import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import {
  adjustPersistedRun,
  classifyErrorCode,
  finishClass,
  SYNELIA_ERROR_CODES,
} from "../src/synelia/run-refusal";

const ev = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, threadId: "t", runId: "r", ...extra }) as unknown as BaseEvent;

const started = ev("RUN_STARTED");
const finished = ev("RUN_FINISHED");
const text = ev("TEXT_MESSAGE_CONTENT", { delta: "bonjour" });
const toolStart = ev("TOOL_CALL_START", { toolCallName: "report_refusal" });

describe("adjustPersistedRun", () => {
  test("empty finish (no text, no tool call) becomes a provider_refusal RUN_ERROR", () => {
    const { events, status } = adjustPersistedRun([started, finished]);
    expect(status).toBe("error");
    // The RUN_FINISHED is REPLACED, never kept alongside the error.
    expect(events.some((e) => (e as { type?: string }).type === "RUN_FINISHED")).toBe(
      false,
    );
    const error = events.find(
      (e) => (e as { type?: string }).type === "RUN_ERROR",
    ) as { message?: string; code?: string; threadId?: string; runId?: string };
    expect(error.code).toBe(SYNELIA_ERROR_CODES.providerRefusal);
    expect(error.message).toBe("content_filter");
    expect(error.threadId).toBe("t");
    expect(error.runId).toBe("r");
  });

  test("a normal answer with text is left untouched (status done)", () => {
    const input = [started, text, finished];
    const { events, status } = adjustPersistedRun(input);
    expect(status).toBe("done");
    expect(events.some((e) => (e as { type?: string }).type === "RUN_FINISHED")).toBe(
      true,
    );
    expect(events.some((e) => (e as { type?: string }).type === "RUN_ERROR")).toBe(
      false,
    );
  });

  test("a run that only called a tool (report_refusal) is not a silent refusal", () => {
    const { status, events } = adjustPersistedRun([started, toolStart, finished]);
    expect(status).toBe("done");
    expect(events.some((e) => (e as { type?: string }).type === "RUN_ERROR")).toBe(
      false,
    );
  });

  test("an existing coded RUN_ERROR keeps its code and drops any RUN_FINISHED", () => {
    const busy = ev("RUN_ERROR", { message: "Thread is busy.", code: "thread_busy" });
    const { events, status } = adjustPersistedRun([started, busy, finished]);
    expect(status).toBe("error");
    const codes = events
      .filter((e) => (e as { type?: string }).type === "RUN_ERROR")
      .map((e) => (e as { code?: string }).code);
    expect(codes).toEqual(["thread_busy"]);
    expect(events.some((e) => (e as { type?: string }).type === "RUN_FINISHED")).toBe(
      false,
    );
  });

  test("RUN_ERROR then RUN_FINISHED and RUN_FINISHED then RUN_ERROR give the same result", () => {
    const err = ev("RUN_ERROR", { message: "boom (HTTP 502)" });
    const a = adjustPersistedRun([started, err, finished]);
    const b = adjustPersistedRun([started, finished, err]);
    for (const out of [a, b]) {
      expect(out.status).toBe("error");
      expect(
        out.events.some((e) => (e as { type?: string }).type === "RUN_FINISHED"),
      ).toBe(false);
      const code = (
        out.events.find(
          (e) => (e as { type?: string }).type === "RUN_ERROR",
        ) as { code?: string }
      ).code;
      // No code on the wire → classified as provider_unavailable (an HTTP error).
      expect(code).toBe(SYNELIA_ERROR_CODES.providerUnavailable);
    }
  });

  test("a RUN_ERROR worded as a refusal without a code is classified provider_refusal", () => {
    const refusal = ev("RUN_ERROR", {
      message: "This request was blocked by the content filter (HTTP 403)",
    });
    const { events } = adjustPersistedRun([started, refusal]);
    const code = (
      events.find(
        (e) => (e as { type?: string }).type === "RUN_ERROR",
      ) as { code?: string }
    ).code;
    expect(code).toBe(SYNELIA_ERROR_CODES.providerRefusal);
  });

  test("the stall watchdog's code survives unchanged", () => {
    const stall = ev("RUN_ERROR", {
      message: "Bot stopped responding. Nothing arrived from it for a minute",
      code: "AGENT_STREAM_STALLED",
    });
    const { events, status } = adjustPersistedRun([started, stall]);
    expect(status).toBe("error");
    expect(
      (
        events.find(
          (e) => (e as { type?: string }).type === "RUN_ERROR",
        ) as { code?: string }
      ).code,
    ).toBe("AGENT_STREAM_STALLED");
  });
});

describe("classifyErrorCode", () => {
  test("refusal wording → provider_refusal", () => {
    expect(classifyErrorCode("blocked by Anthropic's Usage Policy")).toBe(
      SYNELIA_ERROR_CODES.providerRefusal,
    );
    expect(classifyErrorCode("content_filter")).toBe(
      SYNELIA_ERROR_CODES.providerRefusal,
    );
  });
  test("plain HTTP error → provider_unavailable", () => {
    expect(classifyErrorCode("Service unreachable (HTTP 502)")).toBe(
      SYNELIA_ERROR_CODES.providerUnavailable,
    );
  });
});

describe("finishClass", () => {
  test("classifies text, tool, empty refusal, and an error code", () => {
    expect(finishClass([started, text, finished])).toBe("stop");
    expect(finishClass([started, toolStart, finished])).toBe("tool_call");
    expect(finishClass([started, finished])).toBe(
      SYNELIA_ERROR_CODES.providerRefusal,
    );
    expect(
      finishClass([started, ev("RUN_ERROR", { code: "thread_busy" })]),
    ).toBe("thread_busy");
  });
});
