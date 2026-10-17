import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createPilotGate, isPilotGated } from "../src/synelia/pilot-gate";

test("pilot gate: outside-phase-0 surfaces are 404, chat/threads/models/auth pass", async () => {
  const app = new Hono();
  app.use("/api/*", createPilotGate(true));
  app.all("/api/*", (c) => c.text("ok"));
  for (const [method, path] of [
    ["POST", "/api/bots"],
    ["POST", "/api/agents"],
    ["PATCH", "/api/agents/x"],
    ["GET", "/api/plugins/skills"],
    ["POST", "/api/plugins/servers"],
    ["GET", "/api/computers"],
    ["POST", "/api/agent-tools/call"],
    ["GET", "/api/admin/learning"],
    ["POST", "/api/delivery/sms"],
    ["POST", "/api/events/github"],
  ])
    expect((await app.request(path as string, { method })).status).toBe(404);
  for (const [method, path] of [
    ["GET", "/api/agents"],
    ["POST", "/api/copilotkit/agent/a/run"],
    ["GET", "/api/channels"],
    ["GET", "/api/synelia/models"],
    ["POST", "/api/auth/sign-in/email"],
    ["GET", "/api/threads/x"],
  ])
    expect((await app.request(path as string, { method })).status).toBe(200);
  // Allowlist: an unknown/new upstream route is closed by default.
  expect(isPilotGated("GET", "/api/botsx")).toBe(true);
  expect(isPilotGated("GET", "/api/some-new-upstream-feature")).toBe(true);
  expect(isPilotGated("GET", "/assets/index.js")).toBe(false);
  // Harmless empty 200 for reads the conversation screen may still make.
  for (const [method, path, body] of [
    ["GET", "/api/sandboxed/published", []],
    ["PUT", "/api/components/catalogue", { added: [] }],
    ["GET", "/api/computers/synelia-assistant/control", null],
  ] as const) {
    const response = await app.request(path, { method });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(body);
  }
});

test("gate 10: tools are an allowlist (ask*/show* known names only)", async () => {
  const { pilotTools, isPilotGatedTool } = await import(
    "../src/synelia/pilot-gate"
  );
  const offered = [
    "computer_navigate",
    "computer_run_command",
    "report_refusal",
    "generateSandboxedUi",
    "foo_tool",
    "showTableX",
    "askChoice",
    "showTable",
  ].map((name) => ({ name }));
  expect(pilotTools(offered, true)?.map((tool) => tool.name)).toEqual([
    "askChoice",
    "showTable",
  ]);
  expect(isPilotGatedTool("foo_tool")).toBe(true);
  expect(pilotTools(offered, false)).toBe(offered);
});
