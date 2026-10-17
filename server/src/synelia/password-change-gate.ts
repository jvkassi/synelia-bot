import type { MiddlewareHandler } from "hono";
import { isTestAccount } from "./test-accounts";

/**
 * Synelia fork: ONE global gate for the forced password change at first login. While the signed-in
 * user's `must_change_password` is true, every /api/* call answers 403
 * `{ code: "password_change_required" }`.
 *
 * Better Auth is not gated here: its handler (`app.on(["GET","POST"], "/api/auth/*")`) is mounted
 * before this gate and answers first, so get-session, change-password and sign-out (and every other
 * Better Auth endpoint, update-user included, which cannot touch the flag: input:false) never reach
 * it. The other /api/auth verbs (SCIM PUT/PATCH/DELETE) are skipped too: they are Better Auth's.
 * Test accounts (SYNELIA_TEST_ACCOUNTS) are exempt.
 *
 * FAIL CLOSED: with a session cookie, a session lookup that throws answers 503
 * `{ code: "session_unavailable" }` rather than letting the request through.
 */
export const PASSWORD_CHANGE_REQUIRED_BODY = {
  error: "Vous devez changer votre mot de passe.",
  code: "password_change_required",
} as const;

export const SESSION_UNAVAILABLE_BODY = {
  error: "Session momentanément indisponible. Réessayez.",
  code: "session_unavailable",
} as const;

type SessionLookup = (
  headers: Headers,
) => Promise<{ id: string; mustChangePassword?: boolean | null } | undefined>;

export function createPasswordChangeGate(
  lookup: SessionLookup | undefined,
): MiddlewareHandler {
  return async (context, next) => {
    const path = context.req.path;
    if (
      !lookup ||
      path === "/api/auth" ||
      path.startsWith("/api/auth/") ||
      !(context.req.header("cookie") ?? "").includes("session_token")
    ) {
      return next();
    }
    let user: Awaited<ReturnType<SessionLookup>>;
    try {
      user = await lookup(context.req.raw.headers);
    } catch {
      return context.json(SESSION_UNAVAILABLE_BODY, 503);
    }
    if (user?.mustChangePassword && !isTestAccount(user.id)) {
      return context.json(PASSWORD_CHANGE_REQUIRED_BODY, 403);
    }
    return next();
  };
}
