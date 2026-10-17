import { afterEach, beforeEach, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { createAuth } from "../src/auth";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { testEnvironment } from "./support/environment";

/**
 * Synelia fork: through the REAL auth stack (Better Auth built by createAuth, the real requireUser
 * guard, the real masking middleware): GET /api/me with no session. Better Auth answers a request
 * without a session cookie without touching the database, so no schema is needed; the pool points at
 * the test database when one is configured, at an unused local port otherwise.
 */
beforeEach(() => {
  process.env.SYNELIA_MASK_401 = "1";
});
afterEach(() => {
  delete process.env.SYNELIA_MASK_401;
});

function realApp() {
  const config = loadConfig(
    testEnvironment({ OPENBOT_PASSWORD_LOGIN: "true" }),
  );
  const database = createDatabase(
    process.env.TEST_DATABASE_URL?.trim() ||
      "postgres://openbot:openbot@127.0.0.1:1/unused",
    { max: 1 } as never,
  );
  const auth = createAuth(config, database);
  return createApp(config, auth, { rolesForUser: async () => [] });
}

test("real auth: GET /api/me without a session → 403, x-synelia-status: 401, code session_expired, no WWW-Authenticate", async () => {
  const response = await realApp().request("http://localhost:3001/api/me");
  expect(response.status).toBe(403);
  expect(response.headers.get("x-synelia-status")).toBe("401");
  expect(response.headers.get("www-authenticate")).toBeNull();
  expect(await response.json()).toEqual({
    error: "Authentication required.",
    code: "session_expired",
  });
});

test("real auth, masking off: the same request is the raw 401 with the same body", async () => {
  delete process.env.SYNELIA_MASK_401;
  const response = await realApp().request("http://localhost:3001/api/me");
  expect(response.status).toBe(401);
  expect(((await response.json()) as { code: string }).code).toBe(
    "session_expired",
  );
});
