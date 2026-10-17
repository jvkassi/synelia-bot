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

test("pilot: /api/admin is exact METHOD + path (GET people only); everything else 404", async () => {
  const { requireAdmin } = await import("../src/auth/guards");
  // Same order as the app: pilot gate, then a requireUser stand-in, then the real handlers' guard.
  const build = (role: "admin" | "user") => {
    const app = new Hono();
    app.use("/api/*", createPilotGate(true));
    app.use("/api/*", async (c, next) => {
      (c as unknown as { set: (k: string, v: unknown) => void }).set("actor", {
        id: "u",
        role,
      });
      await next();
    });
    app.all("/api/admin/*", (c) => requireAdmin(c as never) ?? c.text("ok"));
    return app;
  };
  const closed: [string, string][] = [
    ["POST", "/api/admin/people/u2/role"],
    ["POST", "/api/admin/people/u2/access"],
    ["GET", "/api/admin/credentials"],
    ["POST", "/api/admin/credentials"],
    ["POST", "/api/admin/credentials/c1/rotate"],
    ["POST", "/api/admin/credentials/c1/revoke"],
    ["GET", "/api/admin/identity-providers"],
    ["PUT", "/api/admin/identity-providers/google"],
    ["DELETE", "/api/admin/identity-providers/google"],
    ["GET", "/api/admin/enterprise"],
    ["POST", "/api/admin/enterprise/network"],
    ["GET", "/api/admin/package"],
    ["GET", "/api/admin/audit-events"],
    ["GET", "/api/admin/learning/settings"],
    ["POST", "/api/admin/people"],
    ["DELETE", "/api/admin/people"],
    ["POST", "/api/admin/status"],
    ["GET", "/api/admin/status"],
    ["POST", "/api/admin/enterprise/people/u2/terminate-computers"],
    ["GET", "/api/admin/people/u2"],
    ["GET", "/api/admin"],
    ["GET", "/api/admin/some-future-router"],
  ];
  const admin = build("admin");
  for (const [method, path] of closed)
    expect([
      method,
      path,
      (await admin.request(path, { method })).status,
    ]).toEqual([method, path, 404]);
  expect((await admin.request("/api/admin/people")).status).toBe(200);
  expect((await admin.request("/api/admin/people?cursor=x")).status).toBe(200);
  const user = build("user");
  for (const [method, path] of [...closed, ["GET", "/api/admin/people"]] as [
    string,
    string,
  ][])
    expect([403, 404]).toContain((await user.request(path, { method })).status);
});

test("pilot: GET /api/admin/enterprise/me passes for any signed-in user, computers capped off", async () => {
  const app = new Hono();
  app.use("/api/*", createPilotGate(true));
  app.get("/api/admin/enterprise/me", (c) =>
    c.json({
      capabilities: {
        useBots: true,
        cloudComputer: true,
        localComputer: true,
        cloudBrowser: true,
      },
      enforced: false,
    }),
  );
  app.all("/api/admin/enterprise/*", (c) => c.text("ok"));
  const response = await app.request("/api/admin/enterprise/me");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    capabilities: Record<string, boolean>;
  };
  expect(body.capabilities).toMatchObject({
    useBots: true,
    cloudComputer: false,
    localComputer: false,
    cloudBrowser: false,
  });
  expect(
    (await app.request("/api/admin/enterprise/me", { method: "POST" })).status,
  ).toBe(404);
  expect((await app.request("/api/admin/enterprise/members")).status).toBe(404);
  expect((await app.request("/api/admin/enterprise")).status).toBe(404);
});

test("pilot: POST /api/agents/:id/declined (report_refusal) passes; other agent writes stay 404", () => {
  expect(isPilotGated("POST", "/api/agents/synelia-assistant/declined")).toBe(
    false,
  );
  expect(isPilotGated("GET", "/api/agents/synelia-assistant/declined")).toBe(
    false,
  ); // GET reads stay as before
  expect(isPilotGated("PUT", "/api/agents/synelia-assistant/declined")).toBe(
    true,
  );
  expect(isPilotGated("POST", "/api/agents/synelia-assistant/declined/x")).toBe(
    true,
  );
  expect(isPilotGated("POST", "/api/agents/synelia-assistant")).toBe(true);
  expect(isPilotGated("POST", "/api/agents")).toBe(true);
});

test("pilot: path tricks under /api/admin never reach a handler", async () => {
  const { createPilotPathGuard } = await import("../src/synelia/pilot-gate");
  const app = new Hono();
  // Same order as app.ts: path guard on every path, then the /api/* gate, then routes.
  app.use("*", createPilotPathGuard(true));
  app.use("/api/*", createPilotGate(true));
  app.all("*", (c) => c.text("HANDLER"));
  for (const path of [
    "//api/admin/credentials",
    "/api/admin/people/",
    "/API/admin/credentials",
    "/Api/admin/people",
    "/api/admin/%63redentials",
    "/api/admin/people/../credentials",
    "/api/admin/people/./",
    "/api/admin/people%2f..%2fcredentials",
    "/api//admin/people",
  ]) {
    const response = await app.request(`http://x${path}`);
    expect([path, response.status]).toEqual([path, 404]);
  }
  expect((await app.request("http://x/api/admin/people?search=a")).status).toBe(
    200,
  );
  expect((await app.request("http://x/assets/app.js")).status).toBe(200);
  expect((await app.request("http://x/")).status).toBe(200);
});
