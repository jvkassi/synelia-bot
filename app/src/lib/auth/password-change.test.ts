import { expect, test } from "bun:test";
import { redirectOnPasswordChange } from "./password-change";

test("a 403 password_change_required navigates to /change-password, once", () => {
  const visited: string[] = [];
  const location = { pathname: "/", assign: (to: string) => visited.push(to) };
  expect(
    redirectOnPasswordChange(
      { status: 403, code: "password_change_required" },
      location,
    ),
  ).toBe(true);
  expect(visited).toEqual(["/change-password"]);
  location.pathname = "/change-password";
  redirectOnPasswordChange({ code: "password_change_required" }, location);
  expect(visited).toHaveLength(1);
});

test("any other error is left alone", () => {
  const visited: string[] = [];
  const location = { pathname: "/", assign: (to: string) => visited.push(to) };
  expect(
    redirectOnPasswordChange(
      Object.assign(new Error("x"), { status: 403 }),
      location,
    ),
  ).toBe(false);
  expect(redirectOnPasswordChange({ code: "thread_busy" }, location)).toBe(
    false,
  );
  expect(visited).toEqual([]);
});
