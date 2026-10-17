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

test("gate 10: tools are an allowlist (ask*/show* known names + report_refusal)", async () => {
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
    "report_refusal",
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
    "/Api/admin/credentials",
    "/Api/admin/people",
    "/api/admin/%63redentials",
    "/api/admin/%2563redentials",
    "/api/admin%2Fcredentials",
    "/api/%2e%2e/api/admin/credentials",
    "/api/admin/credentials/",
    "/api/admin/credentials;x",
    "/api/admin/people;x",
    "/api/admin/people/../credentials",
    "/api/admin/people/./",
    "/api/admin/people%2f..%2fcredentials",
    "/api//admin/people",
    "/%61pi/admin/people",
  ]) {
    const response = await app.request(`http://x${path}`);
    expect([path, response.status]).toEqual([path, 404]);
    expect(await response.text()).not.toBe("HANDLER");
  }
  expect((await app.request("http://x/api/admin/people?search=a")).status).toBe(
    200,
  );
  // encodeURIComponent ids (front: threads, memory, approvals, agents/declined) reach the handler.
  for (const path of [
    "/api/threads/x%3Ay",
    "/api/memory/a%40b",
    "/api/threads/caf%C3%A9%20x",
    "/api/admin/people?q=%2e%2e%2F%63",
  ]) {
    const response = await app.request(`http://x${path}`);
    expect([path, await response.text()]).toEqual([path, "HANDLER"]);
  }
  expect((await app.request("http://x/assets/app.js")).status).toBe(200);
  expect((await app.request("http://x/assets/a%20b.js")).status).toBe(200);
  expect((await app.request("http://x/channel/abc")).status).toBe(200);
  expect((await app.request("http://x/")).status).toBe(200);
});

test("pilot: canonical /api form (RFC 3986), raw path from the request URL", async () => {
  const { isCanonicalApiPath, isNonCanonicalApiPath, rawRequestPath } =
    await import("../src/synelia/pilot-gate");
  expect(rawRequestPath("http://x:3001/api/a%63?b=%2F#c")).toBe("/api/a%63");
  expect(rawRequestPath("https://h.example//api/x")).toBe("//api/x");
  expect(rawRequestPath("http://h")).toBe("/");
  for (const ok of [
    "/api",
    "/api/me",
    "/api/threads/x%3Ay",
    "/api/memory/a%40b",
    "/api/threads/caf%C3%A9",
    "/api/auth/scim/v2/Users",
    "/api/approvals/q%20x/decision",
  ])
    expect([ok, isCanonicalApiPath(ok)]).toEqual([ok, true]);
  for (const bad of [
    "/api/%30",
    "/api/%41",
    "/api/%5A",
    "/api/%7a",
    "/api/%2D",
    "/api/%2e",
    "/api/%5f",
    "/api/%7E",
    "/api/a%2Fb",
    "/api/a%5Cb",
    "/api/a%00",
    "/api/a%25",
    "/api/a%2",
    "/api/a%zz",
    "/api/a;b",
    "/api/a\\b",
    "/api/",
    "/api//a",
    "/api/./a",
    "/api/../a",
    "/apix",
    "/API",
  ])
    expect([bad, isCanonicalApiPath(bad)]).toEqual([bad, false]);
  // Only paths AIMED at /api are judged; the SPA and assets are left alone.
  expect(isNonCanonicalApiPath("/assets/index-Ab_9-x.js")).toBe(false);
  expect(isNonCanonicalApiPath("/channel/x%3Ay")).toBe(false);
  expect(isNonCanonicalApiPath("/apidocs")).toBe(false);
  expect(isNonCanonicalApiPath("/%41PI/admin")).toBe(true);
  expect(isNonCanonicalApiPath("/x/..%2Fapi/admin")).toBe(true);
  expect(isNonCanonicalApiPath("/api\\admin")).toBe(true);
});

test("pilot: app apiUrl() (credentials page URL) keeps %xx intact through the canonical gate", async () => {
  const { apiUrl } = await import("../../app/src/lib/api-url");
  const { createPilotPathGuard } = await import("../src/synelia/pilot-gate");
  const app = new Hono();
  app.use("*", createPilotPathGuard(true));
  app.use("/api/*", createPilotGate(true));
  app.get("/api/memory/:id", (c) => c.text(`HANDLER ${c.req.param("id")}`));
  const page = {
    href: "https://tester:secret@bot.example/channel/x",
    origin: "https://bot.example",
  };
  const url = apiUrl(`/api/memory/${encodeURIComponent("a:b@c é")}`, page);
  expect(url).toBe("https://bot.example/api/memory/a%3Ab%40c%20%C3%A9");
  const response = await app.request(url);
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("HANDLER a:b@c é");
  // A non-canonical spelling built the same way still gets the gate's 404.
  expect(
    (await app.request(apiUrl("/api/admin/%63redentials", page))).status,
  ).toBe(404);
});
