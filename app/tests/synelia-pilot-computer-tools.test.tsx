import { afterEach, describe, expect, test } from "bun:test";
import { computerToolsOffered } from "@/lib/copilot/computer-available";
import { myCapabilitiesQueryOptions } from "@/lib/enterprise/queries";
import { pilot, ui } from "@/lib/i18n";

/*
 * Synelia fork: the pilot has no computer, so the chat never offers the browser, navigate or
 * computer tools, whatever GET /api/admin/enterprise/me answers. Outside the pilot an unresolved
 * switch still reads as allowed. Pilot flags are OFF under `bun test`, so each test sets the one it
 * needs and puts it back.
 */

type Flags = { hideComputerTools: boolean };
const flags = pilot as unknown as Flags;
const saved: Flags = { ...flags };
afterEach(() => Object.assign(flags, saved));

const mine = { visibility: "private", canManage: true } as const;
const nothing = { browser: false, navigate: false, computer: false };
const everything = { browser: true, navigate: true, computer: true };

describe("in the pilot", () => {
  test("unresolved capabilities offer nothing", () => {
    flags.hideComputerTools = true;
    expect(
      computerToolsOffered({ profile: mine, capabilities: undefined }),
    ).toEqual(nothing);
    expect(
      computerToolsOffered({ profile: undefined, capabilities: undefined }),
    ).toEqual(nothing);
  });

  test("every capability on still offers nothing", () => {
    flags.hideComputerTools = true;
    expect(
      computerToolsOffered({
        profile: mine,
        capabilities: {
          cloudBrowser: true,
          cloudNetwork: true,
          cloudComputer: true,
        },
      }),
    ).toEqual(nothing);
  });

  test("/me is not retried and fails in French", () => {
    flags.hideComputerTools = true;
    expect(myCapabilitiesQueryOptions().retry).toBe(false);
    expect(ui.capabilities.loadFailed).toMatch(/autorisations/);
  });
});

describe("outside the pilot", () => {
  test("unresolved capabilities offer everything", () => {
    flags.hideComputerTools = false;
    expect(
      computerToolsOffered({ profile: mine, capabilities: undefined }),
    ).toEqual(everything);
  });

  test("cloudComputer off withholds only the computer", () => {
    flags.hideComputerTools = false;
    expect(
      computerToolsOffered({
        profile: mine,
        capabilities: { cloudComputer: false },
      }),
    ).toEqual({ browser: true, navigate: true, computer: false });
  });

  test("/me keeps the client's default retry", () => {
    flags.hideComputerTools = false;
    expect(myCapabilitiesQueryOptions().retry).toBeUndefined();
  });
});
