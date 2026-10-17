import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  createBasicAuthSafe401,
  mask401Enabled,
} from "../src/synelia/basic-auth-safe";
import { frontBuildSha, mountVersion } from "../src/synelia/version";

/** Behind Traefik basicauth, a raw 401 makes Chrome evict the tester's basic credentials. */
function appWith(enabled: boolean) {
  const app = new Hono();
  app.use("*", createBasicAuthSafe401(enabled));
  app.get("/api/me", (c) => c.json({ error: "Unauthorized" }, 401));
  app.get("/api/challenge", (c) => {
    c.header("www-authenticate", 'Basic realm="x"');
    return c.text("no", 401);
  });
  app.get("/api/forbidden", (c) => c.json({ error: "Forbidden" }, 403));
  app.get("/api/ok", (c) => c.json({ ok: true }));
  return app;
}

test("a 401 leaves as 403 + x-synelia-status: 401, body and content type kept", async () => {
  const response = await appWith(true).request("/api/me");
  expect(response.status).toBe(403);
  expect(response.headers.get("x-synelia-status")).toBe("401");
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ error: "Unauthorized" });
});

test("no WWW-Authenticate ever leaves with a masked 401", async () => {
  const response = await appWith(true).request("/api/challenge");
  expect(response.status).toBe(403);
  expect(response.headers.get("www-authenticate")).toBeNull();
});

test("other statuses are untouched (a real 403 has no marker)", async () => {
  const app = appWith(true);
  const forbidden = await app.request("/api/forbidden");
  expect(forbidden.status).toBe(403);
  expect(forbidden.headers.get("x-synelia-status")).toBeNull();
  expect((await app.request("/api/ok")).status).toBe(200);
  expect((await app.request("/nope")).status).toBe(404);
});

test("opt-in: only SYNELIA_MASK_401=1 masks; unset or anything else keeps raw 401s", async () => {
  expect((await appWith(false).request("/api/me")).status).toBe(401);
  expect(mask401Enabled({ SYNELIA_MASK_401: "1" })).toBe(true);
  expect(mask401Enabled({})).toBe(false);
  expect(mask401Enabled({ SYNELIA_MASK_401: "0" })).toBe(false);
});

test("/version.json: server SHA from SYNELIA_BUILD_SHA, front SHA from dist/version.json, no-store", async () => {
  const dist = mkdtempSync(join(tmpdir(), "synelia-dist-"));
  writeFileSync(join(dist, "version.json"), JSON.stringify({ sha: "abc1234" }));
  const app = new Hono();
  mountVersion(app, dist, { SYNELIA_BUILD_SHA: "def5678" });
  const response = await app.request("/version.json");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    server: "def5678",
    front: "abc1234",
  });
});

test("/version.json: unknown when nothing was stamped", async () => {
  expect(frontBuildSha(undefined)).toBe("unknown");
  expect(frontBuildSha("/nonexistent-dir")).toBe("unknown");
  const app = new Hono();
  mountVersion(app, undefined, {});
  expect(await (await app.request("/version.json")).json()).toEqual({
    server: "unknown",
    front: "unknown",
  });
});

test("the pilot deployment turns it on (compose sets SYNELIA_MASK_401=1 on the server)", async () => {
  const { readFileSync } = await import("node:fs");
  const compose = readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "deploy",
      "synelia",
      "docker-compose.yml",
    ),
    "utf8",
  );
  const server = compose.slice(compose.indexOf("\n  server:"));
  expect(server).toMatch(/\n {6}SYNELIA_MASK_401: "1"\n/);
});
