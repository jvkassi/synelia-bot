/**
 * Synelia fork: the provider-boundary finish_reason logging. The raw finish reason (stop,
 * tool_calls, content_filter, Anthropic refusal) is read from the streamed body BY NAME ONLY and
 * logged beside the provider and model — never any content, prompt, or secret.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { scanFinishReason, timedFetch } from "./synelia-models";

describe("scanFinishReason", () => {
  test("reads the last finish_reason token, ignoring nulls and content", () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"finish_reason is a red herring"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
    expect(scanFinishReason(sse)).toBe("stop");
  });

  test("carries a reason across chunk boundaries and keeps the last", () => {
    let reason = scanFinishReason('..."finish_reason": "content_filter" ...');
    reason = scanFinishReason("no reason here", reason);
    expect(reason).toBe("content_filter");
  });

  test("undefined when the text carries none", () => {
    expect(scanFinishReason('{"choices":[{"delta":{"content":"hi"}}]}')).toBe(
      undefined,
    );
  });
});

describe("timedFetch", () => {
  const sseResponse = (body: string) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

  test("logs the finish_reason and model once the stream drains, never content", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const inner = (async () =>
        sseResponse(
          'data: {"choices":[{"delta":{"content":"secret answer text"},"finish_reason":null}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}\n\n',
        )) as unknown as typeof fetch;
      const fetchWith = timedFetch("router9", inner, "cc/claude-sonnet-5-5");
      const response = await fetchWith("https://provider.invalid/v1/chat");
      // Draining the body is what fires the flush log.
      await response.text();
    } finally {
      log.mockRestore();
    }
    const calls = lines.filter((line) => line.includes('"kind":"provider_call"'));
    const finish = calls.find((line) => line.includes('"finishReason"'));
    expect(finish).toBeDefined();
    const parsed = JSON.parse(finish?.replace("synelia_timing ", "") ?? "{}");
    expect(parsed.finishReason).toBe("content_filter");
    expect(parsed.provider).toBe("router9");
    expect(parsed.model).toBe("cc/claude-sonnet-5-5");
    // No content ever reaches the log.
    expect(lines.join("\n")).not.toContain("secret answer text");
  });

  test("a body-less response still logs status, with no finishReason", async () => {
    const lines: string[] = [];
    const log = spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      const inner = (async () =>
        new Response(null, { status: 429 })) as unknown as typeof fetch;
      const fetchWith = timedFetch("openrouter", inner, "z-ai/glm");
      await fetchWith("https://provider.invalid/v1/chat");
    } finally {
      log.mockRestore();
    }
    const call = lines.find((line) => line.includes('"kind":"provider_call"'));
    const parsed = JSON.parse(call?.replace("synelia_timing ", "") ?? "{}");
    expect(parsed.status).toBe(429);
    expect(parsed.finishReason).toBe(undefined);
  });
});
