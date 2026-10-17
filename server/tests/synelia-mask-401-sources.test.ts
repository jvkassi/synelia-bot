import { afterEach, beforeEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { maskIf401 } from "../src/synelia/basic-auth-safe";
import { testEnvironment } from "./support/environment";

/**
 * Synelia fork: with SYNELIA_MASK_401=1 (the pilot behind Traefik basic auth), EVERY 401 source of the
 * real app leaves as 403 + x-synelia-status: 401 with no WWW-Authenticate; real 403s stay 403.
 */
type User = {
  id: string;
  email: string;
  name: string;
  mustChangePassword?: boolean;
};
let sessionUser: User | null = null;

const auth = {
  handler: (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/api/auth/sign-in/email")
      return Response.json(
        {
          code: "INVALID_EMAIL_OR_PASSWORD",
          message: "Invalid email or password",
        },
        { status: 401, headers: { "www-authenticate": 'Bearer realm="x"' } },
      );
    if (path === "/api/auth/get-session")
      return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
    return new Response(null, { status: 204 });
  },
  api: { getSession: async () => (sessionUser ? { user: sessionUser } : null) },
};

/** Stands in for the CopilotKit runtime (mounted at the root with its own basePath, like the real one). */
function runtime() {
  const handler = new Hono();
  handler.post("/api/copilotkit/agent/:agent/run", () =>
    Response.json({ error: "runtime says no" }, { status: 401 }),
  );
  handler.post(
    "/api/copilotkit/agent/:agent/connect",
    () =>
      new Response("event: error\ndata: {}\n\n", {
        status: 401,
        headers: { "content-type": "text/event-stream" },
      }),
  );
  handler.get("/api/copilotkit/info", () => {
    throw new HTTPException(401, { message: "expired" });
  });
  return handler;
}

function app() {
  return createApp(
    loadConfig(testEnvironment()),
    auth as never,
    { rolesForUser: async () => ["user"] },
    undefined,
    undefined,
    undefined,
    runtime() as never,
  );
}

const SIGNED_IN: User = { id: "u1", email: "u1@openbot.test", name: "U1" };
const cookie = { cookie: "better-auth.session_token=x" };

function expectMasked(response: Response) {
  expect(response.status).toBe(403);
  expect(response.headers.get("x-synelia-status")).toBe("401");
  expect(response.headers.get("www-authenticate")).toBeNull();
}

beforeEach(() => {
  process.env.SYNELIA_MASK_401 = "1";
  sessionUser = null;
});
afterEach(() => {
  delete process.env.SYNELIA_MASK_401;
});

test("Better Auth: wrong password on sign-in is masked, its JSON body (code) kept", async () => {
  const response = await app().request("/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3001",
    },
    body: JSON.stringify({
      email: "x@openbot.test",
      password: "wrong-password-123",
    }),
  });
  expectMasked(response);
  const body = (await response.json()) as { code: string };
  expect(body.code).toBe("INVALID_EMAIL_OR_PASSWORD");
  // Negative: the middleware never touches bodies, so a wrong password is NOT "session expired".
  expect(body.code).not.toBe("session_expired");
});

test("Better Auth: get-session 401 is masked", async () => {
  expectMasked(await app().request("/api/auth/get-session"));
});

test("/api/me with no or expired session is masked, code session_expired (set at the source)", async () => {
  for (const init of [{}, { headers: cookie }]) {
    const response = await app().request("/api/me", init);
    expectMasked(response);
    expect(((await response.json()) as { code: string }).code).toBe(
      "session_expired",
    );
  }
});

test("copilot.ts request-user wrapper: no person → 401 code session_expired, masked; /info passes", async () => {
  const { withRequestUser } = await import("../src/copilot");
  const inner = new Hono();
  inner.all("*", (c) => c.json({ ok: true }));
  const wrapper = withRequestUser(
    inner as never,
    {} as never,
    {} as never,
    async () => undefined as never,
    "/api/copilotkit",
  );
  const outer = new Hono();
  outer.use(
    "*",
    (await import("../src/synelia/basic-auth-safe")).createBasicAuthSafe401(
      true,
    ),
  );
  outer.route("/", wrapper as never);
  const refused = await outer.request("/api/copilotkit/agent/a/run", {
    method: "POST",
  });
  expectMasked(refused);
  expect(await refused.json()).toEqual({
    error: "Sign in to use this deployment.",
    code: "session_expired",
  });
  expect((await outer.request("/api/copilotkit/info")).status).toBe(200);
});

test("CopilotKit runtime: the session guard's 401 and the runtime's own 401 are masked", async () => {
  expectMasked(
    await app().request("/api/copilotkit/agent/a/run", { method: "POST" }),
  );
  sessionUser = SIGNED_IN;
  expectMasked(
    await app().request("/api/copilotkit/agent/a/run", {
      method: "POST",
      headers: cookie,
    }),
  );
});

test("SSE streams (AG-UI run/connect over fetch): the runtime's 401 event-stream and the guard's 401 are masked", async () => {
  sessionUser = SIGNED_IN;
  const connect = await app().request("/api/copilotkit/agent/a/connect", {
    method: "POST",
    headers: cookie,
  });
  expectMasked(connect);
  expect(connect.headers.get("content-type")).toContain("text/event-stream");
  sessionUser = null;
  expectMasked(
    await app().request("/api/copilotkit/agent/a/connect", { method: "POST" }),
  );
});

test("a 401 raised as HTTPException (resolved by Hono's error handling) is masked", async () => {
  sessionUser = SIGNED_IN;
  expectMasked(
    await app().request("/api/copilotkit/info", { headers: cookie }),
  );
});

test("real 403: the forced password change stays 403 password_change_required, no marker", async () => {
  sessionUser = { ...SIGNED_IN, mustChangePassword: true };
  const response = await app().request("/api/me", { headers: cookie });
  expect(response.status).toBe(403);
  expect(response.headers.get("x-synelia-status")).toBeNull();
  expect(((await response.json()) as { code: string }).code).toBe(
    "password_change_required",
  );
});

test("signed in: /api/me is a plain 2xx, nothing masked", async () => {
  sessionUser = SIGNED_IN;
  const response = await app().request("/api/me", { headers: cookie });
  expect(response.status).toBeLessThan(300);
  expect(response.headers.get("x-synelia-status")).toBeNull();
});

test("unset SYNELIA_MASK_401: the same app answers raw 401s (upstream behaviour)", async () => {
  delete process.env.SYNELIA_MASK_401;
  expect((await app().request("/api/me")).status).toBe(401);
});

test("WebSocket upgrade path (outside Hono): maskIf401 masks the 401 and only it", () => {
  const masked = maskIf401(
    new Response("Sign in first.", { status: 401 }),
    true,
  );
  expectMasked(masked);
  const notFound = new Response("x", { status: 404 });
  expect(maskIf401(notFound, true)).toBe(notFound);
  const raw = new Response("x", { status: 401 });
  expect(maskIf401(raw, false)).toBe(raw);
});
