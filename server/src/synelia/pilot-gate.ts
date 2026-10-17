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
 * The request path exactly as it arrived in `request.url`: from the first `/` after the authority to
 * the first `?` or `#`, NOT percent-decoded. This is the string Hono's `getPath` starts from (it then
 * decodes `%xx` with decodeURI when it meets one); the query string is ignored here as it is there.
 *
 * Bun builds `request.url` with the WHATWG URL parser before any of this runs, so `.` and `..`
 * segments, `%2e` and `%2e%2e` included, are already resolved (`/api/admin/people/../credentials`
 * reaches the app as `/api/admin/credentials`). Gate and router both see that resolved path, so
 * they agree on it; the dot-segment rule below is kept for any runtime that does not resolve them.
 */
export function rawRequestPath(url: string): string {
  const schemeEnd = url.indexOf("://");
  const start = schemeEnd === -1 ? 0 : url.indexOf("/", schemeEnd + 3);
  if (start === -1) return "/";
  let end = url.length;
  for (let i = start; i < url.length; i++) {
    const code = url.charCodeAt(i);
    if (code === 63 || code === 35) {
      end = i;
      break;
    }
  }
  return url.slice(start, end);
}

/** Decodes each run of well-formed `%xx` escapes; a run that is not valid UTF-8 is left as is. */
const decodeEscapes = (path: string) =>
  path.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });

/**
 * Where a path really points, whatever games it plays: every `%xx` decoded (up to three rounds, so
 * `%2563` ends as `c`), each segment cut at its first `;`, empty and `.` segments dropped, `..`
 * popping the previous one, and the first segment lowered to `api` when it is any casing of it.
 * Used only to decide whether a request is AIMED at /api; it is never what the router is given.
 */
export function apiTarget(raw: string): string {
  let decoded = raw;
  for (let round = 0; round < 3 && decoded.includes("%"); round++)
    decoded = decodeEscapes(decoded);
  const segments: string[] = [];
  for (const piece of decoded.split(/[/\\]/)) {
    const segment = piece.split(";")[0] ?? "";
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments[0]?.toLowerCase() === "api") segments[0] = "api";
  return `/${segments.join("/")}`;
}

/**
 * Escapes the canonical form never carries (RFC 3986 section 6.2.2.2: an unreserved character is
 * always sent as itself, so `%63`, `%2e`, `%61`, `%7E` are a second spelling of a plain character),
 * plus the ones that change the path's shape or meaning: `%2F` and `%5C` (a separator hidden in a
 * segment), `%00`, and `%25` (a second round of encoding, `%2563`).
 */
const FORBIDDEN_ESCAPE =
  /%(?:[3][0-9]|[46][1-9a-fA-F]|[57][0-9aA]|2[dDeEfF]|5[fFcC]|7[eE]|00|25)/;

/**
 * The canonical form of an /api path, the only form the pilot lets reach an /api route (RFC 3986
 * normalized, never re-encoded):
 *  - starts with exactly `/api` (lower case) followed by `/` or nothing;
 *  - no empty segment (`//`, trailing `/`), no `.` or `..` segment;
 *  - no `;` at all: Hono gives it no meaning, but no pilot route uses it and matrix parameters are
 *    the classic way to make a gate and a router disagree, so it is refused rather than allowed;
 *  - every `%` starts a well-formed `%xx`, and none of them is in FORBIDDEN_ESCAPE.
 * Every other escape is allowed and expected: the front builds ids with encodeURIComponent, so
 * `%3A`, `%40`, `%20`, `%C3%A9`... are legitimate and reach the route, which decodes its params.
 */
export function isCanonicalApiPath(raw: string): boolean {
  if (raw !== "/api" && !raw.startsWith("/api/")) return false;
  if (raw.includes(";") || raw.includes("\\")) return false;
  if (/%(?![0-9a-fA-F]{2})/.test(raw)) return false;
  if (FORBIDDEN_ESCAPE.test(raw)) return false;
  return raw
    .slice(1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Pilot rule: a request aimed at `/api` (by `apiTarget`) must be in canonical form, or it answers 404.
 * An allowlist of one form rather than a list of known tricks: whatever encoding, casing, separator
 * or segment game a request plays, it is not canonical and stops here. Since a canonical path
 * contains no `%2F`, `%5C`, `%25` or encoded unreserved character, decoding it (Hono's decodeURI,
 * which leaves reserved escapes such as `%3A` alone) changes no segment boundary and no prefix: the
 * gates compare the same path, segment for segment, that the router matches.
 *
 * Paths outside `/api` (SPA routes, `/assets/*` with Vite's hashed names, `/health`, `/.well-known/*`)
 * are not judged: no /api handler is reachable from them, and the static server and SPA fallback
 * answer them as before.
 */
export function isNonCanonicalApiPath(raw: string): boolean {
  const target = apiTarget(raw);
  if (target !== "/api" && !target.startsWith("/api/")) return false;
  return !isCanonicalApiPath(raw);
}

export function createPilotPathGuard(
  enabled = pilotEnabled(),
): MiddlewareHandler {
  return async (context, next) => {
    // From the raw URL, not `c.req.path`: that one is already decoded and would hide `%63`.
    if (enabled && isNonCanonicalApiPath(rawRequestPath(context.req.raw.url))) {
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
 * questions and display components below, plus report_refusal (audit only); any other tool the browser offers (agent computer,
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
  // Self-reported decline (computer-tools.tsx): the browser posts it to /api/agents/:id/declined,
  // which writes one bot.declined audit row for a Bot the caller may reach. Audit only, no effect.
  "report_refusal",
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
