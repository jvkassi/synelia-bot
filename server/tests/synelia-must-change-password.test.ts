import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createPasswordChangeGate } from "../src/synelia/password-change-gate";

const appWith = (mustChangePassword: boolean) => {
  const app = new Hono();
  app.use(
    "/api/*",
    createPasswordChangeGate(async () => ({ id: "u1", mustChangePassword })),
  );
  app.all("/api/*", (c) => c.json({ ok: true }));
  return app;
};
const cookie = { headers: { cookie: "better-auth.session_token=x" } };

test("a forced password change blocks every API call (copilotkit runtime and SSE included) with 403", async () => {
  for (const path of [
    "/api/me",
    "/api/copilotkit",
    "/api/copilotkit/agent/a/run",
    "/api/channels/x/events",
  ]) {
    const response = await appWith(true).request(path, {
      method: "POST",
      ...cookie,
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(
      "password_change_required",
    );
  }
});

test("only session, change-password and sign-out pass the allowlist", async () => {
  for (const path of [
    "/api/auth/get-session",
    "/api/auth/change-password",
    "/api/auth/sign-out",
  ]) {
    expect((await appWith(true).request(path, cookie)).status).toBe(200);
  }
});

test("no flag, no session cookie, or a test account (by user id), passes", async () => {
  expect((await appWith(false).request("/api/me", cookie)).status).toBe(200);
  expect((await appWith(true).request("/api/me")).status).toBe(200);
  process.env.SYNELIA_TEST_ACCOUNTS = "u1";
  expect((await appWith(true).request("/api/me", cookie)).status).toBe(200);
  delete process.env.SYNELIA_TEST_ACCOUNTS;
});

test("tester entries come in EMAIL/PASSWORD pairs from SYNELIA_TESTER_<SLUG>_*", async () => {
  const { testerEntries } = await import("../src/auth/bootstrap-password-user");
  expect(
    testerEntries({
      SYNELIA_TESTER_JANE_EXAMPLE_COM_EMAIL: " Jane@Example.com ",
      SYNELIA_TESTER_JANE_EXAMPLE_COM_PASSWORD: "p",
      SYNELIA_TESTER_ORPHAN_EMAIL: "o@x.y",
    }),
  ).toEqual([["jane@example.com", "p"]]);
});
