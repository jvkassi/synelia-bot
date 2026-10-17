import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createPilotGate, isPilotGated } from "../src/synelia/pilot-gate";

test("pilot gate: outside-phase-0 surfaces are 404, chat/threads/models/auth pass", async () => {
  const app = new Hono();
  app.use("/api/*", createPilotGate(true));
  app.all("/api/*", (c) => c.text("ok"));
  for (const [method, path] of [
    ["POST", "/api/bots"], ["POST", "/api/agents"], ["PATCH", "/api/agents/x"], ["GET", "/api/plugins/skills"],
    ["POST", "/api/plugins/servers"], ["GET", "/api/computers"], ["POST", "/api/agent-tools/call"],
    ["GET", "/api/admin/learning"], ["POST", "/api/delivery/sms"], ["POST", "/api/events/github"],
  ])
    expect((await app.request(path as string, { method })).status).toBe(404);
  for (const [method, path] of [
    ["GET", "/api/agents"], ["POST", "/api/copilotkit/agent/a/run"], ["GET", "/api/channels"],
    ["GET", "/api/synelia/models"], ["POST", "/api/auth/sign-in/email"], ["GET", "/api/threads/x"],
  ])
    expect((await app.request(path as string, { method })).status).toBe(200);
  expect(isPilotGated("GET", "/api/botsx")).toBe(false);
});
