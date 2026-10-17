import { expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { isAlreadyAnswered } from "../src/persistence/postgres-runner";

const started = (ids: string[]) =>
  ({ type: "RUN_STARTED", input: { messages: ids.map((id) => ({ id, role: "user" })) } }) as unknown as BaseEvent;
const finished = { type: "RUN_FINISHED" } as BaseEvent;
const errored = { type: "RUN_ERROR" } as BaseEvent;

test("the same message sent twice runs once", () => {
  const history = [{ events: [started(["m1"]), finished] }];
  expect(isAlreadyAnswered([{ id: "m1", role: "user" }], history)).toBe(true);
});

test("a new message, a tool continuation and a resend after an error all run", () => {
  const history = [{ events: [started(["m1"]), finished] }, { events: [started(["m1", "m2"]), errored] }];
  expect(isAlreadyAnswered([{ id: "m1", role: "user" }, { id: "m3", role: "user" }], history)).toBe(false);
  expect(isAlreadyAnswered([{ id: "m1", role: "user" }, { id: "t1", role: "tool" }], history)).toBe(false);
  expect(isAlreadyAnswered([{ id: "m2", role: "user" }], history)).toBe(false);
});
