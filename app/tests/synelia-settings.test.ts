import { expect, test } from "bun:test";
import { isPilotHiddenSettingsPath, pilot, ui } from "@/lib/i18n";

test("standing instructions counter reads in French, with French digit grouping", () => {
  expect(ui.settings.characters(0, 4000)).toMatch(/^0 sur 4\s000 caractères$/u);
  expect(ui.settings.characters(1234, 4000)).toMatch(
    /^1\s234 sur 4\s000 caractères$/u,
  );
});

test("pilot: settings tabs outside phase 0 are closed by URL too, General stays", () => {
  const hidden = [
    "/settings/approvals",
    "/settings/connected-accounts",
    "/settings/connected-accounts/github",
    "/settings/passwords",
    "/settings/components-gallery/chart",
  ];
  for (const path of hidden)
    expect(isPilotHiddenSettingsPath(path)).toBe(pilot.hideSettingsExtras);
  for (const path of ["/settings", "/settings/memory"])
    expect(isPilotHiddenSettingsPath(path)).toBe(false);
});

test("pilot: Notifications (and the devices it lists) is closed by URL too", () => {
  for (const path of [
    "/settings/notifications",
    "/settings/notifications/devices",
  ])
    expect(isPilotHiddenSettingsPath(path)).toBe(
      pilot.hideNotificationsSettings,
    );
  // Not a prefix match on the bare word: a sibling route stays reachable.
  expect(isPilotHiddenSettingsPath("/settings/notifications-other")).toBe(
    false,
  );
});
