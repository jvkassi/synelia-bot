import { describe, expect, test } from "bun:test";
import { dedupeById, isStreamCut } from "./stream-reattach";

describe("stream reattach (gate 12)", () => {
  test("network cuts are recognised, provider errors and user aborts are not", () => {
    expect(isStreamCut(new TypeError("network error"))).toBe(true);
    expect(isStreamCut(new TypeError("Failed to fetch"))).toBe(true);
    expect(isStreamCut(new Error("ECONNRESET: socket closed"))).toBe(true);
    expect(isStreamCut(new Error("User not found. (HTTP 401)"))).toBe(false);
    expect(isStreamCut(new DOMException("aborted", "AbortError"))).toBe(false);
  });
  test("replayed messages are not shown twice", () => {
    const user = { id: "u1", role: "user", content: "Bonjour" };
    const partial = { id: "a1", role: "assistant", content: "Bon" };
    const full = { id: "a1", role: "assistant", content: "Bonjour !" };
    expect(dedupeById([user, partial, user, full])).toEqual([user, full]);
    const clean = [user, full];
    expect(dedupeById(clean)).toBe(clean);
  });
});
