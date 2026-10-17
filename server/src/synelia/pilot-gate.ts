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
] as const;

/**
 * /api/admin is NOT a prefix in the pilot: exact METHOD + path only. The People screen reads its
 * list (GET /api/admin/people only); /api/admin/status, every write (role, access), credentials, identity providers,
 * enterprise, package, audit events, learning, and any router mounted under /api/admin later,
 * answers 404. Role changes go through deploy/synelia/add-tester.sh --role in announced windows.
 */
export const PILOT_ADMIN_ALLOWED: readonly (readonly [string, string])[] = [
  ["GET", "/api/admin/people"], // search/cursor ride in the query string (lib/people/queries.ts)
  // The caller's OWN capability flags (admin/routes.ts `/me`, any signed-in user, actor id only);
  // the chat reads it (lib/copilot/computer-available.ts). Pilot-capped below.
  ["GET", "/api/admin/enterprise/me"],
];

/** Capabilities the pilot never offers, forced false in `/api/admin/enterprise/me`. */
const PILOT_CAPPED_CAPABILITIES = [
  "cloudBrowser",
  "cloudNetwork",
  "cloudComputer",
  "localComputer",
  "passwordManager",
  "slackTeams",
  "teamBots",
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
const AGENT_DECLINED = /^\/api\/agents\/[^/]+\/declined$/;

const under = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

export function pilotEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.SYNELIA_PILOT ?? "1") !== "0";
}

export function isPilotGated(method: string, path: string): boolean {
  if (!path.startsWith("/api/")) return false;
  if (under(path, "/api/admin"))
    return !PILOT_ADMIN_ALLOWED.some(
      ([allowedMethod, allowedPath]) =>
        (method === allowedMethod ||
          (method === "HEAD" && allowedMethod === "GET")) &&
        path === allowedPath,
    );
  if (PILOT_CLOSED_PREFIXES.some((prefix) => under(path, prefix))) return true;
  // report_refusal's audit row (agents/routes.ts `/:agentId/declined`: requireUser, then the store
  // answers 404 unless the caller may reach that Bot; writes one bot.declined audit event, nothing
  // else). Opened exactly, POST only; every other agent write stays closed.
  if (method === "POST" && AGENT_DECLINED.test(path)) return false;
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

/**
 * Non-canonical API paths are refused before any route (pilot only): a double slash, an upper-case
 * `/API`, or a dot segment. Hono matches `/api/*` case-sensitively and literally, so `/API/admin/x`
 * or `//api/admin/x` would skip the `/api/*` gates; the app never builds such URLs.
 */
export function isNonCanonicalApiPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (!/^\/+api(\/|$)/.test(lower) && !lower.includes("/api/")) return false;
  if (path.includes("//")) return true;
  if (!path.startsWith("/api/") && lower.startsWith("/api")) return true;
  return /(^|\/)\.{1,2}(\/|$)/.test(path);
}

export function createPilotPathGuard(
  enabled = pilotEnabled(),
): MiddlewareHandler {
  return async (context, next) => {
    if (enabled && isNonCanonicalApiPath(context.req.path)) {
      console.warn("pilot_blocked non-canonical /api path");
      return context.json({ error: "Not found" }, 404);
    }
    await next();
  };
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
    if (
      enabled &&
      context.req.method === "GET" &&
      context.req.path === "/api/admin/enterprise/me" &&
      context.res.status === 200
    ) {
      const body = (await context.res
        .clone()
        .json()
        .catch(() => null)) as {
        capabilities?: Record<string, boolean>;
      } | null;
      if (!body?.capabilities) return;
      for (const key of PILOT_CAPPED_CAPABILITIES)
        body.capabilities[key] = false;
      context.res = undefined;
      context.res = context.json(body, 200);
    }
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
