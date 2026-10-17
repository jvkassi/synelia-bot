import { expect, test } from "bun:test";
import { type UiStrings, ui } from "../src/lib/i18n";

/**
 * Compile-time proof that a second language fits `UiStrings`: the French values are not literal
 * types, so any string of the same shape is accepted. `bun run typecheck` fails if this regresses.
 * Built from the French dictionary with one value replaced, rather than shipping a full English one.
 */
const en: UiStrings = {
  ...ui,
  locale: "en-US",
  composer: { ...ui.composer, send: "Send message" },
};

test("an English dictionary of the same shape typechecks", () => {
  expect(en.composer.send).toBe("Send message");
  expect(ui.locale).toBe("fr-FR");
});
