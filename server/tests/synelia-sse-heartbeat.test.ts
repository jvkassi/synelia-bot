import { expect, test } from "bun:test";
import { endsEvent, withSseHeartbeat } from "../src/synelia/sse-heartbeat";

const active = (r: Response) =>
  (r as unknown as Record<symbol, () => boolean>)[
    Symbol.for("synelia.heartbeatActive")
  ]();

function controllable() {
  let c!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start: (x) => {
      c = x;
    },
  });
  return {
    response: new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    }),
    push: (s: string) => c.enqueue(new TextEncoder().encode(s)),
    end: () => c.close(),
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("boundary detection handles \\n\\n and \\r\\n\\r\\n", () => {
  expect(endsEvent("data: {}\n\n")).toBe(true);
  expect(endsEvent("data: {}\r\n\r\n")).toBe(true);
  expect(endsEvent('data: {"a":')).toBe(false);
  expect(endsEvent("data: {}\n")).toBe(false);
});

test("quiet stream between events gets pings; data passes through; non-SSE untouched", async () => {
  const src = controllable();
  const wrapped = withSseHeartbeat(src.response, 20);
  setTimeout(() => src.push('data: {"type":"RUN_STARTED"}\n\n'), 5);
  setTimeout(() => src.push('data: {"type":"RUN_FINISHED"}\n\n'), 90);
  setTimeout(() => src.end(), 100);
  const text = await wrapped.text();
  expect(text).toContain(": ping\n\n");
  expect(text.indexOf("RUN_STARTED")).toBeLessThan(
    text.indexOf("RUN_FINISHED"),
  );
  expect(wrapped.headers.get("x-accel-buffering")).toBe("no");
  expect(active(wrapped)).toBe(false); // cleared on upstream end
  const plain = new Response("{}", {
    headers: { "content-type": "application/json" },
  });
  expect(withSseHeartbeat(plain)).toBe(plain);
});

test("an event split in two chunks with a long gap gets NO ping in the middle; output parses", async () => {
  const src = controllable();
  const wrapped = withSseHeartbeat(src.response, 20);
  src.push('data: {"type":"TEXT_MESSAGE_CONTENT","de');
  setTimeout(() => src.push('lta":"Bonjour"}\r\n\r\n'), 120); // gap = 6x the heartbeat period
  setTimeout(() => src.end(), 200);
  const text = await wrapped.text();
  const firstEvent = text.slice(0, text.indexOf("\r\n\r\n"));
  expect(firstEvent).not.toContain(": ping");
  expect(JSON.parse(firstEvent.slice(6)).delta).toBe("Bonjour");
  // Pings may follow the closed event, never precede its end.
  for (const block of text.split(/\r?\n\r?\n/).filter(Boolean))
    expect(block.startsWith("data: ") || block === ": ping").toBe(true);
});

test("timer cleared when the client cancels (disconnect)", async () => {
  const src = controllable();
  const wrapped = withSseHeartbeat(src.response, 20);
  const reader = (wrapped.body as ReadableStream<Uint8Array>).getReader();
  src.push("data: {}\n\n");
  await reader.read();
  expect(active(wrapped)).toBe(true);
  await reader.cancel("client gone");
  expect(active(wrapped)).toBe(false);
  await sleep(50);
});
