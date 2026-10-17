import { describe, expect, test } from "bun:test";
import {
  dedupeById,
  endedWithoutAnswer,
  isStreamCut,
  replayKeeps,
} from "./stream-reattach";

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
  test("an empty run (idempotent resend) leaves the person last and asks for a replay", () => {
    const user = { id: "u1", role: "user" };
    const answer = { id: "a1", role: "assistant" };
    const tool = { id: "t1", role: "tool" };
    expect(endedWithoutAnswer([answer, user])).toBe(true);
    expect(endedWithoutAnswer([user, answer])).toBe(false);
    expect(endedWithoutAnswer([user, tool])).toBe(false);
    expect(endedWithoutAnswer([])).toBe(false);
  });
  test("a replay only adds: a snapshot missing a shown message is not applied", () => {
    const user = { id: "u1", role: "user" };
    const answer = { id: "a1", role: "assistant" };
    const refused = { id: "u2", role: "user" };
    expect(replayKeeps([user], [user, answer])).toEqual([user, answer]);
    expect(replayKeeps([user, refused], [user, answer])).toBeNull();
    expect(replayKeeps([user], [])).toBeNull();
    expect(replayKeeps([user], [user, answer, answer])).toEqual([user, answer]);
  });
});
