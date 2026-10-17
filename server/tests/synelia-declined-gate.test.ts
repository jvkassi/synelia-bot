import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createAgentRoutes } from "../src/agents/routes";
import { createPilotGate } from "../src/synelia/pilot-gate";

/**
 * report_refusal through the pilot gate and the real agents router: the reachable Bot answers 2xx and
 * writes one audit row; a Bot the caller cannot reach answers 404 and writes nothing; every other
 * write under /api/agents is the pilot's 404.
 */
test("pilot: POST /api/agents/:id/declined only, ownership checked by the handler", async () => {
  const written: unknown[] = [];
  const store = {
    // A's private Bot is visible to A only, as the real store's actor check answers.
    get: async (actor: { id: string }, agentId: string) =>
      agentId === "bot-a" && actor.id === "user-a"
        ? { id: "bot-a", visibility: "private" }
        : undefined,
  };
  const auditStore = {
    record: async (event: unknown) => {
      written.push(event);
    },
    append: async (event: unknown) => {
      written.push(event);
    },
    insert: async (event: unknown) => {
      written.push(event);
    },
  };
  const as = (userId: string) => {
    const app = new Hono();
    app.use("/api/*", createPilotGate(true));
    const requireUser = async (
      c: { set: (k: string, v: unknown) => void },
      next: () => Promise<void>,
    ) => {
      c.set("actor", { id: userId, email: `${userId}@x.io`, role: "user" });
      await next();
    };
    app.route(
      "/api/agents",
      createAgentRoutes(
        store as never,
        requireUser as never,
        false,
        auditStore as never,
      ),
    );
    return app;
  };
  const post = (app: Hono, path: string) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "hors périmètre" }),
    });

  const ownStatus = (await post(as("user-a"), "/api/agents/bot-a/declined"))
    .status;
  expect(ownStatus).toBeGreaterThanOrEqual(200);
  expect(ownStatus).toBeLessThan(300);
  const afterOwn = written.length;
  expect(afterOwn).toBeGreaterThan(0);

  expect((await post(as("user-b"), "/api/agents/bot-a/declined")).status).toBe(
    404,
  );
  expect(written.length).toBe(afterOwn);

  for (const path of [
    "/api/agents",
    "/api/agents/bot-a",
    "/api/agents/bot-a/hide",
    "/api/agents/bot-a/declined/x",
  ])
    expect((await post(as("user-a"), path)).status).toBe(404);
});
