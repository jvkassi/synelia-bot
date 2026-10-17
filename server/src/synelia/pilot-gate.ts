import type { MiddlewareHandler } from "hono";

/**
 * Synelia fork: server-side twin of the UI `pilot` flags (app/src/lib/i18n). Hiding a screen does
 * not remove its API, so while the pilot is on, every surface outside phase 0 answers 404 exactly
 * like an unknown route (no 403, nothing that says the feature exists). On by default; set
 * SYNELIA_PILOT=0 to get upstream behaviour back.
 */
/**
 * ALLOWLIST of the API surfaces the pilot screens use (inventory of app/src fetch calls on sign-in,
 * home, conversation, sidebar, settings and admin). Anything else answers 404, so a route added
 * upstream later is closed until somebody opens it here on purpose.
 */
export const PILOT_ALLOWED_PREFIXES = [
  "/api/auth", // Better Auth (sign-in, session)
  "/api/me",
  "/api/capabilities",
  "/api/channels", // conversations (the UI calls them "conversations")
  "/api/copilotkit", // AG-UI run / connect / threads
  "/api/threads",
  "/api/synelia", // models, badge map, run model
  "/api/attachments",
  "/api/audio", // dictation in the composer
  "/api/settings",
  "/api/approvals", // in-run decisions only; settings sub-routes closed below
  "/api/memory",
  "/api/route",
  "/api/admin", // admin screens; learning is closed below
] as const;
/*
 * Deliberately NOT allowed (settings screens outside phase 0, gate item 6): approval settings
 * (rules, preferences, team: closed above), connected
 * accounts (/api/identity, /api/plugins/connections), passwords/credentials (/api/passwords,
 * /api/sign-in-requests), components gallery (/api/components). They answer 404.
 */

/** Closed even under an allowed prefix. */
const PILOT_CLOSED_PREFIXES = [
  "/api/admin/learning",
  // Approval SETTINGS are outside phase 0; /decision, /questions/*/respond and /computer/* stay
  // open (inline-approval.tsx, waiting.tsx, approval-tools.tsx during a run).
  "/api/approvals/rules",
  "/api/approvals/preferences",
  "/api/approvals/team",
] as const;

/**
 * Reads the conversation screen still makes for features the pilot hides: answered with a harmless
 * empty 200 so a stale tab or a missed front guard never turns into an error on screen.
 */
const PILOT_EMPTY_READS: { method: string; pattern: RegExp; body: unknown }[] =
  [
    { method: "GET", pattern: /^\/api\/sandboxed\/published$/, body: [] },
    {
      method: "GET",
      pattern: /^\/api\/plugins\/for\/[^/]+$/,
      body: { tools: [], skills: [] },
    },
    {
      method: "GET",
      pattern: /^\/api\/components\/for-agent\/[^/]+$/,
      body: { components: [] },
    },
    {
      method: "PUT",
      pattern: /^\/api\/components\/catalogue$/,
      body: { added: [] },
    },
    {
      method: "GET",
      pattern: /^\/api\/computers\/[^/]+\/control$/,
      body: null,
    },
    {
      method: "GET",
      pattern: /^\/api\/proactive\/suggestions$/,
      body: { suggestions: [] },
    },
  ];

/** Read-only listing stays (the model picker and the transcript need the Bot names). */
const AGENT_PATH = /^\/api\/agents(\/|$)/;

const under = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

export function pilotEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.SYNELIA_PILOT ?? "1") !== "0";
}

export function isPilotGated(method: string, path: string): boolean {
  if (!path.startsWith("/api/")) return false;
  if (PILOT_CLOSED_PREFIXES.some((prefix) => under(path, prefix))) return true;
  if (AGENT_PATH.test(path)) return method !== "GET" && method !== "HEAD";
  return !PILOT_ALLOWED_PREFIXES.some((prefix) => under(path, prefix));
}

export function pilotEmptyRead(
  method: string,
  path: string,
): { body: unknown } | undefined {
  return PILOT_EMPTY_READS.find(
    (read) => read.method === method && read.pattern.test(path),
  );
}

export function createPilotGate(enabled = pilotEnabled()): MiddlewareHandler {
  return async (context, next) => {
    if (enabled) {
      const empty = pilotEmptyRead(context.req.method, context.req.path);
      if (empty) return context.json(empty.body as never, 200);
      if (isPilotGated(context.req.method, context.req.path)) {
        // Prefix only (two segments): no ids, no query string in the log.
        const prefix = context.req.path.split("/").slice(0, 3).join("/");
        console.warn(`pilot_blocked ${context.req.method} ${prefix}`);
        return context.json({ error: "Not found" }, 404);
      }
    }
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
