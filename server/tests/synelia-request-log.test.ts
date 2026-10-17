import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createRequestLog, requestLogLine } from "../src/synelia/request-log";
import { isTestAccount, testAccounts } from "../src/synelia/test-accounts";

test("a log line has no query string, no body/headers, and the thread id from the path", () => {
  const line = JSON.parse(
    requestLogLine({
      at: new Date("2026-10-17T12:00:00Z"),
      method: "GET",
      path: "/api/threads/t-1?token=secret",
      status: 200,
      durationMs: 12.4,
      userId: "u1",
    }),
  );
  expect(line).toEqual({
    ts: "2026-10-17T12:00:00.000Z",
    method: "GET",
    path: "/api/threads/t-1",
    status: 200,
    durationMs: 12,
    userId: "u1",
    threadId: "t-1",
  });
});

test("middleware writes a daily file and prunes files older than 7 days", async () => {
  const dir = await mkdtemp(join(tmpdir(), "reqlog-"));
  await writeFile(join(dir, "requests-2000-01-01.jsonl"), "{}\n");
  const app = new Hono();
  app.use("/api/*", createRequestLog(dir));
  app.get("/api/ping", (c) => c.json({ ok: true }));
  await app.request("/api/ping?x=1", {
    headers: { authorization: "Bearer nope" },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const files = await readdir(dir);
  expect(files.some((name) => name === "requests-2000-01-01.jsonl")).toBe(
    false,
  );
  const today = files.find((name) => name.startsWith("requests-")) as string;
  const content = await readFile(join(dir, today), "utf8");
  expect(content).toContain('"path":"/api/ping"');
  expect(content).not.toContain("Bearer");
  expect(content).not.toContain("x=1");
});

test("test accounts are matched by user id and flagged in the log", () => {
  const list = testAccounts(" u-e2e , u-test ");
  expect(isTestAccount("u-e2e", list)).toBe(true);
  expect(isTestAccount("jv.e2e@synelia.tech", list)).toBe(false);
  expect(isTestAccount(undefined, list)).toBe(false);
  process.env.SYNELIA_TEST_ACCOUNTS = "u-e2e";
  const line = JSON.parse(
    requestLogLine({
      at: new Date(),
      method: "GET",
      path: "/api/me",
      status: 200,
      durationMs: 1,
      userId: "u-e2e",
    }),
  );
  expect(line.test).toBe(true);
  delete process.env.SYNELIA_TEST_ACCOUNTS;
});

test("no logged /api/auth path carries a segment longer than 20 chars (tokens in the path)", async () => {
  const { requestLogLine } = await import("../src/synelia/request-log");
  for (const raw of [
    "/api/auth/reset-password/eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuvwxyz",
    "/api/auth/callback/google?code=4%2F0AbcdefghijklmnopqrstuvwxyZ",
    "/api/auth/verify-email/0123456789abcdef0123456789abcdef",
    "/api/auth/sign-in/email",
  ]) {
    const { path } = JSON.parse(
      requestLogLine({
        at: new Date(),
        method: "GET",
        path: raw,
        status: 200,
        durationMs: 1,
      }),
    ) as { path: string };
    expect(path.startsWith("/api/auth")).toBe(true);
    expect(path.split("/").every((segment) => segment.length <= 20)).toBe(true);
  }
});
