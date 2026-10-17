import { expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Hono } from "hono";
import { clearMustChangePasswordAfter } from "../src/auth/index";
import { createPasswordChangeGate } from "../src/synelia/password-change-gate";

/**
 * Full cycle on a real Better Auth (memory adapter, same hook as production): flagged account ->
 * gate 403 -> change-password with revokeOtherSessions -> flag false -> /api/me 200 with the NEW
 * session cookie; the old cookie no longer signs in.
 */
test("forced password change: full cycle clears the flag and the new session passes the gate", async () => {
  const db: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  const auth = betterAuth({
    baseURL: "http://localhost:3001",
    secret: "test-secret-test-secret-test-secret-123",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    session: { cookieCache: { enabled: true, maxAge: 300 } },
    user: {
      additionalFields: {
        mustChangePassword: {
          type: "boolean",
          defaultValue: false,
          input: false,
        },
      },
    },
    hooks: {
      after: clearMustChangePasswordAfter(async (userId) => {
        const row = db.user?.find((user) => user.id === userId);
        if (row) row.mustChangePassword = false;
      }),
    },
  });
  const app = new Hono();
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.use(
    "/api/*",
    createPasswordChangeGate(
      async (headers) =>
        (
          await auth.api.getSession({
            headers,
            query: { disableCookieCache: true },
          })
        )?.user as never,
    ),
  );
  app.get("/api/me", (c) => c.json({ ok: true }));
  const origin = {
    origin: "http://localhost:3001",
    "content-type": "application/json",
  };
  const cookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .filter((c) => !c.endsWith("="))
      .join("; ");

  await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: origin,
    body: JSON.stringify({
      email: "t@x.io",
      password: "first-password-1",
      name: "t",
    }),
  });
  (db.user?.[0] as Record<string, unknown>).mustChangePassword = true;
  const signIn = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: origin,
    body: JSON.stringify({ email: "t@x.io", password: "first-password-1" }),
  });
  const oldCookie = cookieOf(signIn);
  expect(
    (await app.request("/api/me", { headers: { cookie: oldCookie } })).status,
  ).toBe(403);

  const change = await app.request("/api/auth/change-password", {
    method: "POST",
    headers: { ...origin, cookie: oldCookie },
    body: JSON.stringify({
      currentPassword: "first-password-1",
      newPassword: "second-password-2",
      revokeOtherSessions: true,
    }),
  });
  expect(change.status).toBe(200);
  expect(db.user?.[0]?.mustChangePassword).toBe(false);
  const newCookie = cookieOf(change);
  expect(newCookie).toContain("session_token");
  expect(
    (await app.request("/api/me", { headers: { cookie: newCookie } })).status,
  ).toBe(200);
  const session = await app.request("/api/auth/get-session", {
    headers: { cookie: newCookie },
  });
  expect(
    ((await session.json()) as { user: { mustChangePassword: boolean } }).user
      .mustChangePassword,
  ).toBe(false);
});
