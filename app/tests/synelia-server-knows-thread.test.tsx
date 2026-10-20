/**
 * Synelia fork (item 6): the ONE GET /api/threads/:id the chat makes before it decides a cut turn was
 * "not sent". `known === false` (the server has no run for this thread) is the only answer that means
 * not-sent; a known thread, a non-OK status, or a failed lookup all mean "a run may exist", so a
 * genuinely sent turn is never discarded (the caller reattaches/replays instead). This is also the
 * decision the reattach-FAILED path consults, which happy-dom cannot drive end to end (buffered bodies
 * cannot model a cut AFTER RUN_STARTED), so it is pinned directly here.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { serverKnowsThread } from "@/components/channels/channel-chat";

let original: typeof fetch;
beforeEach(() => {
  original = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

const stubFetch = (handler: () => Promise<Response> | Response) => {
  globalThis.fetch = (async () => handler()) as unknown as typeof fetch;
};

test("known:false -> false (not sent)", async () => {
  stubFetch(() => Response.json({ known: false, lastError: null }));
  expect(await serverKnowsThread("t1")).toBe(false);
});

test("known:true -> true (a run exists, reattach)", async () => {
  stubFetch(() =>
    Response.json({ known: true, lastError: null, activeRunId: "r1" }),
  );
  expect(await serverKnowsThread("t1")).toBe(true);
});

test("a non-OK status -> true (cannot tell, never claim not-sent)", async () => {
  stubFetch(() => new Response("nope", { status: 502 }));
  expect(await serverKnowsThread("t1")).toBe(true);
});

test("a failed lookup -> true (cannot tell)", async () => {
  stubFetch(() => {
    throw new TypeError("Failed to fetch");
  });
  expect(await serverKnowsThread("t1")).toBe(true);
});

test("no thread id -> false (nothing can be on the server)", async () => {
  let called = false;
  stubFetch(() => {
    called = true;
    return Response.json({ known: true });
  });
  expect(await serverKnowsThread(undefined)).toBe(false);
  expect(await serverKnowsThread(null)).toBe(false);
  expect(called).toBe(false);
});

/*
 * pass10b (Frontend Expert blocker 1): `known` only says the thread exists. With the id of the
 * message this turn added, the server must hold THAT message as its last stored user message (or have
 * a run in flight) before the client reattaches.
 */
test("pass10b: known thread with prior runs, this message absent (lastUserMessageId is an older one) -> false", async () => {
  stubFetch(() =>
    Response.json({
      known: true,
      lastError: null,
      activeRunId: null,
      lastUserMessageId: "u-older",
    }),
  );
  expect(await serverKnowsThread("t1", "u-new")).toBe(false);
});

test("pass10b: known thread, this message stored as the last user message -> true", async () => {
  stubFetch(() =>
    Response.json({
      known: true,
      lastError: null,
      activeRunId: null,
      lastUserMessageId: "u-new",
    }),
  );
  expect(await serverKnowsThread("t1", "u-new")).toBe(true);
});

test("pass10b: known thread, no stored user message (null) -> false", async () => {
  stubFetch(() =>
    Response.json({ known: true, activeRunId: null, lastUserMessageId: null }),
  );
  expect(await serverKnowsThread("t1", "u-new")).toBe(false);
});

test("pass10b: a run in flight (activeRunId) -> true even before its messages are stored", async () => {
  stubFetch(() =>
    Response.json({
      known: true,
      activeRunId: "r-live",
      lastUserMessageId: "u-older",
    }),
  );
  expect(await serverKnowsThread("t1", "u-new")).toBe(true);
});

test("pass10b: an older server without lastUserMessageId -> true (cannot tell)", async () => {
  stubFetch(() => Response.json({ known: true, activeRunId: null }));
  expect(await serverKnowsThread("t1", "u-new")).toBe(true);
});
