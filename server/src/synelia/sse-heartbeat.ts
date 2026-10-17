/**
 * Synelia fork: keep a Server-Sent Events response alive while the model is thinking.
 *
 * Root cause of the browser's "network error" ~10-17 s into a long run: Bun.serve closes a
 * connection after `idleTimeout` (10 s by default) without a byte written, and a model can stay
 * silent longer than that before its first token. Two fixes, both applied in http-server.ts:
 *  - the AG-UI routes get `server.timeout(request, 0)` (no idle limit for that request);
 *  - every text/event-stream response gets an SSE comment (`: ping`) every 5 s, so no hop (Bun,
 *    Traefik, a corporate proxy, the browser) ever sees an idle stream. Comments are ignored by
 *    every SSE parser, AG-UI's included.
 */
export const SSE_HEARTBEAT_MS = 5_000;
const PING = new TextEncoder().encode(": ping\n\n");

export function withSseHeartbeat(
  response: Response,
  everyMs = SSE_HEARTBEAT_MS,
): Response {
  // A websocket upgrade answers with no Response at all: pass it through untouched.
  if (!response?.headers) return response;
  const type = response.headers.get("content-type") ?? "";
  if (!response.body || !type.includes("text/event-stream")) return response;
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        try {
          controller.enqueue(PING);
        } catch {
          clearInterval(timer);
        }
      }, everyMs);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        clearInterval(timer);
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      clearInterval(timer);
      return reader.cancel(reason);
    },
  });
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache, no-transform");
  headers.set("x-accel-buffering", "no");
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
