/**
 * Synelia fork: the bridge-side decision that turns a silent provider refusal into a persisted
 * RUN_ERROR, and gives every RUN_ERROR a stable code. Pure, so no database here (the reload is
 * covered in synelia-persistence.integration.test.ts).
 */
import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { resolveModel } from "../src/synelia/models";
import {
  adjustPersistedRun,
  classifyErrorCode,
  computeRetryable,
  EFFECTFUL_TOOLS,
  finishClass,
  finishedOutputTokens,
  replayEvents,
  SYNELIA_ERROR_CODES,
  usage0Allowlist,
  usage0Refusal,
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
    expect(
      events.some((e) => (e as { type?: string }).type === "RUN_FINISHED"),
    ).toBe(false);
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
    expect(
      events.some((e) => (e as { type?: string }).type === "RUN_FINISHED"),
    ).toBe(true);
    expect(
      events.some((e) => (e as { type?: string }).type === "RUN_ERROR"),
    ).toBe(false);
  });

  test("a run that only called a tool (report_refusal) is not a silent refusal", () => {
    const { status, events } = adjustPersistedRun([
      started,
      toolStart,
      finished,
    ]);
    expect(status).toBe("done");
    expect(
      events.some((e) => (e as { type?: string }).type === "RUN_ERROR"),
    ).toBe(false);
  });

  test("an existing coded RUN_ERROR keeps its code and drops any RUN_FINISHED", () => {
    const busy = ev("RUN_ERROR", {
      message: "Thread is busy.",
      code: "thread_busy",
    });
    const { events, status } = adjustPersistedRun([started, busy, finished]);
    expect(status).toBe("error");
    const codes = events
      .filter((e) => (e as { type?: string }).type === "RUN_ERROR")
      .map((e) => (e as { code?: string }).code);
    expect(codes).toEqual(["thread_busy"]);
    expect(
      events.some((e) => (e as { type?: string }).type === "RUN_FINISHED"),
    ).toBe(false);
  });

  test("RUN_ERROR then RUN_FINISHED and RUN_FINISHED then RUN_ERROR give the same result", () => {
    const err = ev("RUN_ERROR", { message: "boom (HTTP 502)" });
    const a = adjustPersistedRun([started, err, finished]);
    const b = adjustPersistedRun([started, finished, err]);
    for (const out of [a, b]) {
      expect(out.status).toBe("error");
      expect(
        out.events.some(
          (e) => (e as { type?: string }).type === "RUN_FINISHED",
        ),
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
      events.find((e) => (e as { type?: string }).type === "RUN_ERROR") as {
        code?: string;
      }
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
        events.find((e) => (e as { type?: string }).type === "RUN_ERROR") as {
          code?: string;
        }
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

describe("computeRetryable", () => {
  const error = ev("RUN_ERROR", { code: "provider_refusal" });

  test("a run with no tool call is retryable", () => {
    expect(computeRetryable([started, error])).toBe(true);
  });

  test("a run that called an effectful tool (report_refusal) is not retryable", () => {
    expect(computeRetryable([started, toolStart, error])).toBe(false);
  });

  test("a non-effectful display tool stays retryable", () => {
    const show = ev("TOOL_CALL_START", { toolCallName: "showTable" });
    expect(computeRetryable([started, show, error])).toBe(true);
  });

  test("a LEGACY run (stored event without metadata) with report_refusal is not retryable", () => {
    // No metadata.retryable anywhere: the value is derived purely from the tool-call event.
    const legacy = [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      {
        type: "TOOL_CALL_START",
        toolCallId: "c1",
        toolCallName: "report_refusal",
      },
      {
        type: "RUN_ERROR",
        threadId: "t",
        runId: "r",
        message: "content_filter",
      },
    ] as unknown as BaseEvent[];
    expect(computeRetryable(legacy)).toBe(false);
  });

  test("the effectful set is closed: an unknown tool is retry-safe", () => {
    const other = ev("TOOL_CALL_START", { toolCallName: "somethingNew" });
    expect(computeRetryable([started, other, error], EFFECTFUL_TOOLS)).toBe(
      true,
    );
  });
});

describe("usage0Refusal (allowlist-gated silent-refusal signal, off by default)", () => {
  const finishedUsage = (out: number | null) =>
    ev("RUN_FINISHED", {
      usage: out === null ? undefined : [{ outputTokens: out, inputTokens: 5 }],
    });
  const on = usage0Allowlist("router9:cc/claude-sonnet-5-5");
  const ctx = { provider: "router9", model: "cc/claude-sonnet-5-5" };
  const textContent = ev("TEXT_MESSAGE_CONTENT", {
    messageId: "m",
    delta: "English refusal",
  });
  const base = [started, textContent, finishedUsage(0)];

  test("outputTokens reads from a usage array", () => {
    expect(finishedOutputTokens([started, finishedUsage(0)])).toBe(0);
    expect(finishedOutputTokens([started, finishedUsage(12)])).toBe(12);
    expect(
      finishedOutputTokens([started, finishedUsage(null)]),
    ).toBeUndefined();
  });

  test("disabled by default: empty allowlist never triggers, even on the proven pair", () => {
    expect(usage0Refusal(base, ctx, usage0Allowlist(""))).toBe(false);
  });

  test("allowlisted pair with 0 tokens, text and no tool call triggers", () => {
    expect(usage0Refusal(base, ctx, on)).toBe(true);
  });

  test("EXACT match only: another Sonnet version (cc/claude-sonnet-5-6) does NOT match", () => {
    expect(
      usage0Refusal(
        base,
        { provider: "router9", model: "cc/claude-sonnet-5-6" },
        on,
      ),
    ).toBe(false);
    // and a prefix of the allowlisted model never matches either
    expect(
      usage0Refusal(
        base,
        { provider: "router9", model: "cc/claude-sonnet-5" },
        on,
      ),
    ).toBe(false);
  });

  test("usage must be PRESENT and == 0: a usage-absent answer never triggers", () => {
    // Modeled on the konnect 5369-char answer: real text, usage absent -> no trigger.
    const longText = ev("TEXT_MESSAGE_CONTENT", {
      messageId: "m",
      delta: "x".repeat(5369),
    });
    expect(
      usage0Refusal([started, longText, finishedUsage(null)], ctx, on),
    ).toBe(false);
  });

  test("negative: a genuine short reply with usage > 0 is never flagged", () => {
    expect(
      usage0Refusal([started, textContent, finishedUsage(3)], ctx, on),
    ).toBe(false);
  });

  test("negative: usage 0 on a non-allowlisted model (Gemini) never triggers", () => {
    const gemini = { provider: "router9", model: "gemini/gemini-3.8-flash" };
    expect(usage0Refusal(base, gemini, on)).toBe(false);
  });

  test("negative: a run with a tool call + usage 0 never triggers", () => {
    expect(
      usage0Refusal(
        [started, textContent, toolStart, finishedUsage(0)],
        ctx,
        on,
      ),
    ).toBe(false);
  });

  test("a run with no text (empty finish) is not this rule (handled by empty-finish)", () => {
    expect(usage0Refusal([started, finishedUsage(0)], ctx, on)).toBe(false);
  });

  test("adjustPersistedRun: an allowlisted usage0 run becomes provider_refusal (reason usage0), text kept, no RUN_FINISHED", () => {
    const { events, status } = adjustPersistedRun(base, ctx, on);
    expect(status).toBe("error");
    const types = events.map((e) => (e as { type?: string }).type);
    expect(types).not.toContain("RUN_FINISHED");
    expect(types).toContain("TEXT_MESSAGE_CONTENT"); // text is KEPT in storage for auditing
    const error = events.find(
      (e) => (e as { type?: string }).type === "RUN_ERROR",
    ) as { code?: string; metadata?: { reason?: string } } | undefined;
    expect(error?.code).toBe(SYNELIA_ERROR_CODES.providerRefusal);
    expect(error?.metadata?.reason).toBe("usage0");
  });

  test("adjustPersistedRun: without the allowlist, a usage0 run stays done (text untouched)", () => {
    const { events, status } = adjustPersistedRun(
      base,
      ctx,
      usage0Allowlist(""),
    );
    expect(status).toBe("done");
    expect(events.map((e) => (e as { type?: string }).type)).toContain(
      "RUN_FINISHED",
    );
  });

  test("adjustPersistedRun: the empty-finish RUN_ERROR carries reason empty_finish", () => {
    const { events } = adjustPersistedRun([started, finished]);
    const error = events.find(
      (e) => (e as { type?: string }).type === "RUN_ERROR",
    ) as { metadata?: { reason?: string } } | undefined;
    expect(error?.metadata?.reason).toBe("empty_finish");
  });
});

describe("replayEvents (the single replay rule)", () => {
  const textStart = ev("TEXT_MESSAGE_START", {
    messageId: "m",
    role: "assistant",
  });
  const textContent = ev("TEXT_MESSAGE_CONTENT", {
    messageId: "m",
    delta: "english refusal",
  });
  const textEnd = ev("TEXT_MESSAGE_END", { messageId: "m" });
  const refusalError = ev("RUN_ERROR", {
    message: "content_filter",
    code: "provider_refusal",
  });
  const unavailError = ev("RUN_ERROR", {
    message: "boom",
    code: "provider_unavailable",
  });
  const types = (events: BaseEvent[]) =>
    events.map((e) => (e as { type?: string }).type);
  const runError = (events: BaseEvent[]) =>
    events.find((e) => (e as { type?: string }).type === "RUN_ERROR") as
      | { metadata?: { retryable?: boolean } }
      | undefined;

  test("a provider_refusal run (last) drops its assistant text and stamps retryable", () => {
    const out = replayEvents([
      { events: [started, textStart, textContent, textEnd, refusalError] },
    ]);
    expect(types(out).some((t) => t?.startsWith("TEXT_MESSAGE"))).toBe(false);
    expect(types(out)).toContain("RUN_ERROR");
    expect(runError(out)?.metadata?.retryable).toBe(true);
  });

  test("a provider_refusal run that called report_refusal is retryable:false", () => {
    const out = replayEvents([
      { events: [started, toolStart, textContent, refusalError] },
    ]);
    expect(runError(out)?.metadata?.retryable).toBe(false);
  });

  test("a SUPERSEDED error run drops its text; a later answered run keeps its own", () => {
    const out = replayEvents([
      { events: [started, textStart, textContent, unavailError] },
      {
        events: [
          ev("RUN_STARTED"),
          ev("TEXT_MESSAGE_START", { messageId: "a", role: "assistant" }),
          ev("TEXT_MESSAGE_CONTENT", {
            messageId: "a",
            delta: "la vraie réponse",
          }),
          ev("TEXT_MESSAGE_END", { messageId: "a" }),
          finished,
        ],
      },
    ]);
    const deltas = out
      .filter((e) => (e as { type?: string }).type === "TEXT_MESSAGE_CONTENT")
      .map((e) => (e as { delta?: string }).delta ?? "")
      .join(" ");
    expect(deltas).toContain("la vraie réponse");
    expect(deltas).not.toContain("english refusal");
  });

  test("a normal answered run is replayed untouched (no suppression)", () => {
    const out = replayEvents([
      { events: [started, textStart, textContent, textEnd, finished] },
    ]);
    expect(types(out).some((t) => t === "TEXT_MESSAGE_CONTENT")).toBe(true);
    expect(types(out)).toContain("RUN_FINISHED");
  });
});

describe("allowlist key = resolveModel(SYNELIA_DEFAULT_MODEL) (konnect config 2026-10-17)", () => {
  // Prod .env.mastra: SYNELIA_MODELS_MODE=on, SYNELIA_DEFAULT_MODEL=router9:cc/claude-sonnet-5-5,
  // SYNELIA_MODELS lists rapide/alternatif/code/raisonnement. The provider/model COLUMNS konnect
  // stored for the refusal runs 759e3cbb, 0e9258d0 and 0b071677 are router9 / cc/claude-sonnet-5-5.
  const configuredDefaultId = "router9:cc/claude-sonnet-5-5";
  const list = {
    defaultModel: configuredDefaultId,
    models: [
      {
        id: "router9:cc/claude-sonnet-5-5",
        provider: "router9",
        model: "cc/claude-sonnet-5-5",
        available: true,
      },
      {
        id: "router9:gemini/gemini-3.8-flash",
        provider: "router9",
        model: "gemini/gemini-3.8-flash",
        available: true,
      },
      {
        id: "openrouter:deepseek/deepseek-v4.1-flash",
        provider: "openrouter",
        model: "deepseek/deepseek-v4.1-flash",
        available: true,
      },
      {
        id: "openrouter:z-ai/glm-5.3",
        provider: "openrouter",
        model: "z-ai/glm-5.3",
        available: true,
      },
    ],
  };

  test("resolveModel(default) builds exactly the key stored for run 0b071677, and the env allowlist contains it", () => {
    const resolved = resolveModel(configuredDefaultId, list);
    // Same shape persistence/live build the key from (`${provider}:${model}`).
    expect(resolved).toEqual({
      provider: "router9",
      model: "cc/claude-sonnet-5-5",
    });
    const key = `${resolved.provider}:${resolved.model}`;
    expect(key).toBe("router9:cc/claude-sonnet-5-5"); // == stored provider | model columns
    // THE EXACT env value to enable the rule: SYNELIA_REFUSAL_USAGE0_MODELS=router9:cc/claude-sonnet-5-5
    expect(usage0Allowlist("router9:cc/claude-sonnet-5-5").has(key)).toBe(true);
  });

  test("the Alternatif model (Gemini) key is NOT in that allowlist", () => {
    const gemini = resolveModel("router9:gemini/gemini-3.8-flash", list);
    expect(
      usage0Allowlist("router9:cc/claude-sonnet-5-5").has(
        `${gemini.provider}:${gemini.model}`,
      ),
    ).toBe(false);
  });
});
