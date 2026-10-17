import { expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/client";
import { isAlreadyAnswered } from "../src/persistence/postgres-runner";

const started = (ids: string[]) =>
  ({
    type: "RUN_STARTED",
    input: { messages: ids.map((id) => ({ id, role: "user" })) },
  }) as unknown as BaseEvent;
const finished = { type: "RUN_FINISHED" } as BaseEvent;
const errored = { type: "RUN_ERROR" } as BaseEvent;

test("the same message sent twice runs once", () => {
  const history = [{ events: [started(["m1"]), finished] }];
  expect(isAlreadyAnswered([{ id: "m1", role: "user" }], history)).toBe(true);
});

test("a new message, a tool continuation and a resend after an error all run", () => {
  const history = [
    { events: [started(["m1"]), finished] },
    { events: [started(["m1", "m2"]), errored] },
  ];
  expect(
    isAlreadyAnswered(
      [
        { id: "m1", role: "user" },
        { id: "m3", role: "user" },
      ],
      history,
    ),
  ).toBe(false);
  expect(
    isAlreadyAnswered(
      [
        { id: "m1", role: "user" },
        { id: "t1", role: "tool" },
      ],
      history,
    ),
  ).toBe(false);
  expect(isAlreadyAnswered([{ id: "m2", role: "user" }], history)).toBe(false);
});

test("a run with BOTH RUN_FINISHED and RUN_ERROR for the message does not count as answered", () => {
  // Aligns with persist()'s rule (postgres-runner.ts): any RUN_ERROR stores status "error", so the
  // run never answered and "send again" must still run, whichever order the two events arrived in.
  const finishedThenError = [
    { events: [started(["m1"]), finished, errored] },
  ];
  expect(isAlreadyAnswered([{ id: "m1", role: "user" }], finishedThenError)).toBe(
    false,
  );
  const errorThenFinished = [
    { events: [started(["m1"]), errored, finished] },
  ];
  expect(isAlreadyAnswered([{ id: "m1", role: "user" }], errorThenFinished)).toBe(
    false,
  );
});
