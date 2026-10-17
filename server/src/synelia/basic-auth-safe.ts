import type { MiddlewareHandler } from "hono";

/**
 * Synelia fork: the app never answers HTTP 401 while a basic-auth proxy stands in front of it.
 *
 * WHY. The pilot sits behind Traefik `basicauth` (realm "Synelia Bot"). Chrome keeps the basic
 * credentials a tester typed once and sends them preemptively on every same-origin request. When one
 * of those requests comes back 401 — even the app's own JSON 401 with no `WWW-Authenticate`, such as
 * `GET /api/me` before sign-in or a wrong password on `/api/auth/sign-in/email` — Chrome concludes
 * the basic credentials were rejected and evicts them from its auth cache. Every following request
 * then reaches Traefik bare, gets Traefik's 401 + `WWW-Authenticate: Basic`, and the prompt comes
 * back in a loop (measured in headless Chrome 155 against a local basic-auth gate: with the app's
 * 401 the next fetch goes out without Authorization; with 403 or 200 it keeps it).
 *
 * WHAT. Any 401 produced behind this middleware leaves as 403 with `x-synelia-status: 401` and no
 * `WWW-Authenticate`; body and other headers are untouched. The browser client (app/src/lib/client.ts
 * `unmaskStatus`) turns it back into a 401, so "signed out" / "session expired" logic is unchanged.
 * Mounted first, outside the request log, so the log still records the real 401.
 *
 * Opt-in: SYNELIA_MASK_401=1 (set in deploy/synelia/docker-compose.yml, the deployment that has the
 * basic-auth proxy). Unset, the server answers raw 401s as upstream does, and the upstream suites
 * that assert 401 are unaffected.
 */
export const MASKED_STATUS_HEADER = "x-synelia-status";

export function mask401Enabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.SYNELIA_MASK_401 === "1";
}

/** The masked form of a 401 (403 + marker, no WWW-Authenticate); any other response unchanged. */
export function maskIf401(
  response: Response,
  enabled: boolean = mask401Enabled(),
): Response {
  if (!enabled || response.status !== 401) return response;
  const headers = new Headers(response.headers);
  headers.delete("www-authenticate");
  headers.set(MASKED_STATUS_HEADER, "401");
  return new Response(response.body, {
    status: 403,
    statusText: "Forbidden",
    headers,
  });
}

/**
 * Outermost Hono middleware. It sees the final response of everything mounted after it: route
 * handlers, the Better Auth handler, the CopilotKit runtime (run/connect SSE included), and errors
 * turned into responses by `app.onError` / `HTTPException` (Hono resolves those inside `next()`).
 * The one 401 written outside Hono, the computer-stream WebSocket upgrade in http-server.ts, goes
 * through `maskIf401` there.
 */
export function createBasicAuthSafe401(
  enabled: boolean = mask401Enabled(),
): MiddlewareHandler {
  return async (context, next) => {
    await next();
    if (!enabled || context.res.status !== 401) return;
    const masked = maskIf401(context.res, true);
    context.res = undefined;
    context.res = masked;
  };
}
