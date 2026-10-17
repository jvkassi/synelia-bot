/**
 * Synelia fork: keep a Server-Sent Events response alive while the model is thinking.
 *
 * Root cause of the browser's "network error" ~10-17 s into a long run: Bun.serve closes a
 * connection after `idleTimeout` (10 s by default) without a byte written, and a model can stay
 * silent longer than that before its first token. Two fixes, both applied in http-server.ts:
 *  - the AG-UI routes get `server.timeout(request, 0)` (no idle limit for that request);
 *  - a text/event-stream response gets an SSE comment (`: ping`) when NOTHING was forwarded for
 *    5 s AND the last forwarded byte closed an event (`\n\n` or `\r\n\r\n`). A ping is never
 *    injected in the middle of an event, so the stream always parses. Comments are ignored by
 *    every SSE parser, AG-UI's included. The timer is cleared on upstream end, error, and client
 *    cancel/disconnect.
 */
export const SSE_HEARTBEAT_MS = 5_000;
const PING = new TextEncoder().encode(": ping\n\n");

/** Whether `tail` (the last bytes forwarded) ends an SSE event. */
export function endsEvent(tail: string): boolean {
  return /(\r\n|\n|\r)(\r\n|\n|\r)$/.test(tail);
}

export function withSseHeartbeat(
  response: Response,
  everyMs = SSE_HEARTBEAT_MS,
): Response {
  // A websocket upgrade answers with no Response at all: pass it through untouched.
  if (!response?.headers) return response;
  const type = response.headers.get("content-type") ?? "";
  if (!response.body || !type.includes("text/event-stream")) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastWrite = Date.now();
  // Before the first byte, a ping is safe: nothing is open.
  let atBoundary = true;
  let tail = "";
  const stop = () => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Checked at a finer grain than the period so a quiet stream is pinged ~everyMs after its
      // last byte rather than up to 2x later.
      timer = setInterval(
        () => {
          if (!atBoundary || Date.now() - lastWrite < everyMs) return;
          try {
            controller.enqueue(PING);
            lastWrite = Date.now();
          } catch {
            stop();
          }
        },
        Math.max(Math.floor(everyMs / 5), 1),
      );
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          stop();
          controller.close();
          return;
        }
        controller.enqueue(value);
        lastWrite = Date.now();
        tail = (tail + decoder.decode(value, { stream: true })).slice(-8);
        atBoundary = endsEvent(tail);
      } catch (error) {
        stop();
        controller.error(error);
      }
    },
    cancel(reason) {
      stop();
      return reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");
  headers.delete("content-length");
  return Object.assign(
    new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    {
      /** For tests: whether the heartbeat timer is still armed. */
      [Symbol.for("synelia.heartbeatActive")]: () => timer !== undefined,
    },
  );
}
