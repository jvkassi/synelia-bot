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
