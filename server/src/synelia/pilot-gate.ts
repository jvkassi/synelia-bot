import type { MiddlewareHandler } from "hono";

/**
 * Synelia fork: server-side twin of the UI `pilot` flags (app/src/lib/i18n). Hiding a screen does
 * not remove its API, so while the pilot is on, every surface outside phase 0 answers 404 exactly
 * like an unknown route (no 403, nothing that says the feature exists). On by default; set
 * SYNELIA_PILOT=0 to get upstream behaviour back.
 */
export const PILOT_GATED_PREFIXES = [
  "/api/bots", // Bot lifecycle (create/hire/retire)
  "/api/team-bots",
  "/api/plugins", // Skills, MCP servers, connections, Composio, grants
  "/api/computers", // agent computer
  "/api/host-access",
  "/api/sandboxed",
  "/api/agent-tools", // tool launch
  "/api/demonstrations",
  "/api/routines",
  "/api/responsibilities",
  "/api/proactive",
  "/api/voice",
  "/api/components",
  "/api/groups",
  "/api/delivery", // outbound channels (SMS, webhooks, opentag)
  "/api/events", // inbound triggers (email, GitHub, webhooks) that start runs
  "/api/admin/learning",
] as const;

/** Read-only listing stays (the model picker and the transcript need the Bot names). */
const AGENT_WRITE = /^\/api\/agents(\/|$)/;

export function pilotEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.SYNELIA_PILOT ?? "1") !== "0";
}

export function isPilotGated(method: string, path: string): boolean {
  if (
    PILOT_GATED_PREFIXES.some(
      (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    )
  )
    return true;
  return AGENT_WRITE.test(path) && method !== "GET" && method !== "HEAD";
}

export function createPilotGate(enabled = pilotEnabled()): MiddlewareHandler {
  return async (context, next) => {
    if (enabled && isPilotGated(context.req.method, context.req.path))
      return context.json({ error: "Not found" }, 404);
    await next();
  };
}

/**
 * PERMANENT RULE (gate item 10): an ALLOWLIST. In the pilot the Bot may only use the in-chat
 * questions and display components below; any other tool the browser offers (agent computer,
 * sandboxed UI, anything added upstream later) is removed before the run.
 */
export const PILOT_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  "askApproval",
  "askChoice",
  "askForm",
  "showActivityReport",
  "showAreaChart",
  "showBarChart",
  "showChecklist",
  "showLineChart",
  "showMetrics",
  "showNotice",
  "showPieChart",
  "showProgress",
  "showQuote",
  "showRecord",
  "showTable",
]);

export function isPilotGatedTool(name: string): boolean {
  return !PILOT_ALLOWED_TOOLS.has(name);
}

export function pilotTools<T extends { name: string }>(
  tools: T[] | undefined,
  enabled = pilotEnabled(),
): T[] | undefined {
  if (!enabled || !tools) return tools;
  return tools.filter((tool) => !isPilotGatedTool(tool.name));
}
