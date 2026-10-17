/**
 * Synelia fork: the LIVE path turns a silent provider refusal into a RUN_ERROR on the stream the
 * browser sees, from the SAME decision as persistence (refusalReason). Pure rxjs, no database.
 */
import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { lastValueFrom, of, toArray } from "rxjs";
import { liveRefusalTransform } from "../src/persistence/postgres-runner";
import {
  adjustPersistedRun,
  usage0Allowlist,
} from "../src/synelia/run-refusal";

const ev = (type: string, extra: Record<string, unknown> = {}) =>
  ({ type, threadId: "t", runId: "r", ...extra }) as unknown as BaseEvent;
const started = ev("RUN_STARTED");
const textContent = ev("TEXT_MESSAGE_CONTENT", {
  messageId: "m",
  delta: "English refusal",
});
const toolStart = ev("TOOL_CALL_START", {
  toolCallId: "c",
  toolCallName: "report_refusal",
});
const finishedUsage = (out: number | null) =>
  ev("RUN_FINISHED", {
    usage: out === null ? undefined : [{ outputTokens: out, inputTokens: 5 }],
  });

const on = usage0Allowlist("router9:cc/claude-sonnet-5-5");
const ctx = { provider: "router9", model: "cc/claude-sonnet-5-5" };

const live = async (
  events: BaseEvent[],
  context: { provider?: string; model?: string },
  allowlist = on,
) =>
  (await lastValueFrom(
    liveRefusalTransform(
      of(...events),
      async () => context,
      { runId: "r", threadId: "t" },
      allowlist,
    ).pipe(toArray()),
  )) as {
    type: string;
    code?: string;
    metadata?: { reason?: string; retryable?: boolean };
  }[];
const types = (events: { type: string }[]) => events.map((e) => e.type);

describe("liveRefusalTransform (browser stream)", () => {
  test("allowlisted pair + usage 0 + text: emits RUN_ERROR provider_refusal, NO RUN_FINISHED, and matches the persisted run", async () => {
    const events = [started, textContent, finishedUsage(0)];
    const out = await live(events, ctx);
    expect(types(out)).not.toContain("RUN_FINISHED");
    const error = out.find((e) => e.type === "RUN_ERROR");
    expect(error?.code).toBe("provider_refusal");
    expect(error?.metadata?.reason).toBe("usage0");
    expect(error?.metadata?.retryable).toBe(true);
    // Persisted outcome from the ONE decision function matches: RUN_ERROR, no RUN_FINISHED.
    const persisted = adjustPersistedRun(events, ctx, on);
    expect(persisted.status).toBe("error");
    expect(
      persisted.events.map((e) => (e as { type?: string }).type),
    ).not.toContain("RUN_FINISHED");
    const perr = persisted.events.find(
      (e) => (e as { type?: string }).type === "RUN_ERROR",
    ) as { code?: string; metadata?: { reason?: string } } | undefined;
    expect(perr?.code).toBe("provider_refusal");
    expect(perr?.metadata?.reason).toBe("usage0");
  });

  test("empty finish (no text, no tool) emits RUN_ERROR live (reason empty_finish)", async () => {
    const out = await live([started, finishedUsage(0)], ctx);
    expect(types(out)).not.toContain("RUN_FINISHED");
    expect(out.find((e) => e.type === "RUN_ERROR")?.metadata?.reason).toBe(
      "empty_finish",
    );
  });

  test("negative: usage > 0 still emits RUN_FINISHED live (no RUN_ERROR)", async () => {
    const out = await live([started, textContent, finishedUsage(3)], ctx);
    expect(types(out)).toContain("RUN_FINISHED");
    expect(out.some((e) => e.type === "RUN_ERROR")).toBe(false);
  });

  test("negative: usage absent still emits RUN_FINISHED live", async () => {
    const out = await live([started, textContent, finishedUsage(null)], ctx);
    expect(types(out)).toContain("RUN_FINISHED");
    expect(out.some((e) => e.type === "RUN_ERROR")).toBe(false);
  });

  test("negative: non-allowlisted model (Gemini) + usage 0 still emits RUN_FINISHED live", async () => {
    const gemini = { provider: "router9", model: "gemini/gemini-3.8-flash" };
    const out = await live([started, textContent, finishedUsage(0)], gemini);
    expect(types(out)).toContain("RUN_FINISHED");
    expect(out.some((e) => e.type === "RUN_ERROR")).toBe(false);
  });

  test("negative: a tool call + usage 0 still emits RUN_FINISHED live", async () => {
    const out = await live(
      [started, textContent, toolStart, finishedUsage(0)],
      ctx,
    );
    expect(types(out)).toContain("RUN_FINISHED");
    expect(out.some((e) => e.type === "RUN_ERROR")).toBe(false);
  });

  test("a real RUN_ERROR passes through untouched (not RUN_FINISHED)", async () => {
    const out = await live(
      [
        started,
        ev("RUN_ERROR", { message: "boom", code: "provider_unavailable" }),
      ],
      ctx,
    );
    expect(out.filter((e) => e.type === "RUN_ERROR").length).toBe(1);
    expect(out.find((e) => e.type === "RUN_ERROR")?.code).toBe(
      "provider_unavailable",
    );
  });
});

describe("liveRefusalTransform short-circuit (item 5: no #models() await when allowlist empty)", () => {
  const empty = usage0Allowlist("");

  const runWithSpy = async (events: BaseEvent[]) => {
    let resolveCalls = 0;
    const out = (await lastValueFrom(
      liveRefusalTransform(
        of(...events),
        async () => {
          resolveCalls += 1;
          return ctx;
        },
        { runId: "r", threadId: "t" },
        empty,
      ).pipe(toArray()),
    )) as { type: string; code?: string; metadata?: { reason?: string } }[];
    return { out, resolveCalls };
  };

  test("a normal finish forwards RUN_FINISHED and NEVER resolves the model", async () => {
    const { out, resolveCalls } = await runWithSpy([
      started,
      textContent,
      finishedUsage(0),
    ]);
    expect(types(out)).toContain("RUN_FINISHED");
    expect(out.some((e) => e.type === "RUN_ERROR")).toBe(false);
    expect(resolveCalls).toBe(0);
  });

  test("an empty finish still becomes RUN_ERROR empty_finish without resolving the model", async () => {
    const { out, resolveCalls } = await runWithSpy([started, finishedUsage(0)]);
    expect(types(out)).not.toContain("RUN_FINISHED");
    expect(out.find((e) => e.type === "RUN_ERROR")?.metadata?.reason).toBe(
      "empty_finish",
    );
    expect(resolveCalls).toBe(0);
  });

  test("with a NON-empty allowlist the model IS resolved (contrast)", async () => {
    let resolveCalls = 0;
    await lastValueFrom(
      liveRefusalTransform(
        of(started, textContent, finishedUsage(0)),
        async () => {
          resolveCalls += 1;
          return ctx;
        },
        { runId: "r", threadId: "t" },
        on,
      ).pipe(toArray()),
    );
    expect(resolveCalls).toBe(1);
  });
});
