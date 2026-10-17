import { expect, test } from "bun:test";
import { pilotRecipient } from "../src/lib/agents/pilot-recipient";

const roster = [{ id: "general-assistant" }, { id: "synelia-assistant" }];

test("pilot: synelia-assistant even with several Bots, no routing call", () => {
  expect(pilotRecipient(roster, true, "general-assistant")).toBe(
    "synelia-assistant",
  );
});

test("pilot without synelia-assistant: the default recipient", () => {
  expect(
    pilotRecipient([{ id: "general-assistant" }], true, "general-assistant"),
  ).toBe("general-assistant");
  expect(pilotRecipient(undefined, true, undefined)).toBeUndefined();
});

test("outside the pilot: undefined, so the home routes as upstream does", () => {
  expect(pilotRecipient(roster, false, "synelia-assistant")).toBeUndefined();
});
