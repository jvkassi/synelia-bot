import { expect, test } from "bun:test";
import { withSseHeartbeat } from "../src/synelia/sse-heartbeat";

test("silent SSE stream gets ': ping' comments; data passes through; non-SSE untouched", async () => {
  let push: (s: string) => void = () => {};
  let end: () => void = () => {};
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (s) => controller.enqueue(new TextEncoder().encode(s));
      end = () => controller.close();
    },
  });
  const wrapped = withSseHeartbeat(
    new Response(source, { headers: { "content-type": "text/event-stream" } }),
    20,
  );
  setTimeout(() => push('data: {"type":"RUN_STARTED"}\n\n'), 5);
  setTimeout(() => push('data: {"type":"RUN_FINISHED"}\n\n'), 90);
  setTimeout(() => end(), 100);
  const text = await wrapped.text();
  expect(text).toContain(": ping\n\n");
  expect(text.indexOf("RUN_STARTED")).toBeLessThan(
    text.indexOf("RUN_FINISHED"),
  );
  expect(wrapped.headers.get("x-accel-buffering")).toBe("no");
  const plain = new Response("{}", {
    headers: { "content-type": "application/json" },
  });
  expect(withSseHeartbeat(plain)).toBe(plain);
});
