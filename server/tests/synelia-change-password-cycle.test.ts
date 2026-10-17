import { expect, test } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Hono } from "hono";
import {
  clearMustChangePasswordAfter,
  confirmedPasswordChangeUserId,
} from "../src/auth/index";
import { createPasswordChangeGate } from "../src/synelia/password-change-gate";

/**
 * Full cycle on a real Better Auth (memory adapter, same hook as production): flagged account ->
 * gate 403 -> change-password with revokeOtherSessions -> flag false -> /api/me 200 with the NEW
 * session cookie; the old cookie no longer signs in.
 */
async function flaggedAccount() {
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

  return { app, db, origin, cookieOf, oldCookie };
}

test("forced password change: full cycle clears the flag and the new session passes the gate", async () => {
  const { app, db, origin, cookieOf, oldCookie } = await flaggedAccount();
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

test("wrong current/temporary password: change refused, flag stays true in DB, gate still 403", async () => {
  const { app, db, origin, oldCookie } = await flaggedAccount();
  const change = await app.request("/api/auth/change-password", {
    method: "POST",
    headers: { ...origin, cookie: oldCookie },
    body: JSON.stringify({
      currentPassword: "not-the-temporary-password",
      newPassword: "second-password-2",
      revokeOtherSessions: true,
    }),
  });
  expect(change.status).toBeGreaterThanOrEqual(400);
  expect(db.user?.[0]?.mustChangePassword).toBe(true);
  expect(
    (await app.request("/api/me", { headers: { cookie: oldCookie } })).status,
  ).toBe(403);
  // The temporary password still works and still lands on the gate.
  const again = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: origin,
    body: JSON.stringify({ email: "t@x.io", password: "first-password-1" }),
  });
  expect(again.status).toBe(200);
});

test("the hook clears only on a confirmed success", () => {
  const session = { user: { id: "u1" } };
  const ok = { token: "t", user: { id: "u1" } };
  expect(
    confirmedPasswordChangeUserId({ returned: ok, newSession: session }),
  ).toBe("u1");
  expect(confirmedPasswordChangeUserId({ returned: ok, session })).toBe("u1");
  // Failures, whatever shape a future Better Auth gives them.
  expect(
    confirmedPasswordChangeUserId({
      returned: new Error("INVALID_PASSWORD"),
      session,
    }),
  ).toBeNull();
  expect(
    confirmedPasswordChangeUserId({
      returned: new Response("{}", { status: 400 }),
      session,
    }),
  ).toBeNull();
  expect(
    confirmedPasswordChangeUserId({
      returned: new Response("{}", { status: 200 }),
      session,
    }),
  ).toBeNull();
  expect(
    confirmedPasswordChangeUserId({
      returned: { status: 400, user: { id: "u1" } },
      session,
    }),
  ).toBeNull();
  expect(
    confirmedPasswordChangeUserId({
      returned: { statusCode: 401, user: { id: "u1" } },
      session,
    }),
  ).toBeNull();
  expect(
    confirmedPasswordChangeUserId({ returned: { message: "bad" }, session }),
  ).toBeNull();
  expect(
    confirmedPasswordChangeUserId({ returned: undefined, session }),
  ).toBeNull();
  // No session, or the result names somebody else.
  expect(confirmedPasswordChangeUserId({ returned: ok })).toBeNull();
  expect(
    confirmedPasswordChangeUserId({
      returned: { token: "t", user: { id: "u2" } },
      session,
    }),
  ).toBeNull();
});
