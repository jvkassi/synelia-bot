import { afterEach, describe, expect, test } from "bun:test";
import { ProxiedCopilotRuntimeAgent } from "@copilotkit/react-core/v2";
import { client } from "@/lib/client";
import {
  endedWithoutAnswer,
  isAlreadyRunning,
  isStreamCut,
} from "./stream-reattach";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const serve = (response: () => Response) => {
  globalThis.fetch = (async () => response()) as unknown as typeof fetch;
};

describe("thread busy (a run already going) vs a real failure", () => {
  /*
   * (a) The Postgres lock: `LocalIntelligenceError("Thread is busy.", 409, "thread_busy")`
   * (server/src/persistence/local-intelligence.ts:556). IF that 409 ever reached the browser as an
   * HTTP body or a RUN_ERROR event, these are the shapes it would have, and both are caught.
   * Today it does not: the browser's runs go through the in-memory runner (case b), and the lock is
   * only taken by server-side turns, where toolkit/src/copilotkit/thread-lock.ts:89 turns the 409
   * into `null` and toolkit/src/run-turn.ts:389 lets it throw server-side. No server code writes
   * `code` into a JSON body.
   */
  test("(a) Postgres acquire 409 with code thread_busy is treated as already running", async () => {
    serve(() =>
      Response.json(
        { error: "Thread is busy.", code: "thread_busy" },
        { status: 409 },
      ),
    );
    const caught = await client("/api/anything").catch(
      (error: unknown) => error,
    );
    expect((caught as { status?: number }).status).toBe(409);
    expect((caught as { code?: string }).code).toBe("thread_busy");
    expect(isAlreadyRunning(caught)).toBe(true);
    expect(
      isAlreadyRunning({
        type: "RUN_ERROR",
        message: "Thread is busy.",
        code: "thread_busy",
      }),
    ).toBe(true);
  });

  /*
   * (b) The in-memory runner's `throw new Error("Thread already running")`
   * (@copilotkit/runtime 1.77 dist/v2/runtime/runner/in-memory.mjs:300), raised inside
   * PostgresAgentRunner.run's switchMap (server/src/persistence/postgres-runner.ts:209). The SSE
   * handler has already answered 200 (handlers/shared/sse-response.mjs:129-130); its `error`
   * callback only logs and closes the stream (:100-108). No RUN_ERROR, no message, no code: what
   * reaches the browser is a 200 event stream with ZERO events.
   *
   * So the sentence check in isAlreadyRunning (stream-reattach.ts:44) never sees it. The run
   * resolves without failing, the person's message is still last, and channel-chat's
   * `endedWithoutAnswer` replay (connectAgent, the same path as the idempotent resend) shows the
   * run that is going. That is what this test pins.
   */
  test("(b) in-memory 'Thread already running' arrives as an empty 200 stream: no failure, replay path", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      urls.push(url);
      // The runtime's /info, asked once before the first run; then the run itself.
      if (url.endsWith("/info")) return Response.json({ agents: {} });
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;
    const agent = new ProxiedCopilotRuntimeAgent({
      runtimeUrl: "http://localhost/api/copilotkit",
      agentId: "default",
    });
    agent.messages = [{ id: "u1", role: "user", content: "Bonjour" }];
    const seen: unknown[] = [];
    const result = await agent.runAgent(
      { runId: "r2" },
      {
        onRunFailed: ({ error }) => {
          seen.push(error);
        },
        onRunErrorEvent: ({ event }) => {
          seen.push(event);
        },
      },
    );
    expect(urls.at(-1)).toBe(
      "http://localhost/api/copilotkit/agent/default/run",
    );
    expect(seen).toEqual([]);
    expect(result.newMessages).toEqual([]);
    expect(endedWithoutAnswer(agent.messages)).toBe(true);
    // The runner's sentence is still recognised, should a future path carry it as is.
    expect(isAlreadyRunning(new Error("Thread already running"))).toBe(true);
  });

  test("(c) a provider error mentioning (HTTP 409) is a failure, not swallowed", () => {
    const provider = new Error(
      "Conflict: request already in progress for this key. (HTTP 409)",
    );
    expect(isAlreadyRunning(provider)).toBe(false);
    expect(isStreamCut(provider)).toBe(false);
    expect(
      isAlreadyRunning({
        type: "RUN_ERROR",
        message: "Upstream provider error (HTTP 409)",
        code: "provider_error",
      }),
    ).toBe(false);
    expect(
      isAlreadyRunning(
        Object.assign(new Error("Conflict (HTTP 409)"), { status: 409 }),
      ),
    ).toBe(false);
  });
});
