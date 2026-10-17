import type { MiddlewareHandler } from "hono";
import { isTestAccount } from "./test-accounts";

/**
 * Synelia fork: ONE global gate for the forced password change at first login. While the signed-in
 * user's `must_change_password` is true, every /api/* call answers 403
 * `{ code: "password_change_required" }` except the ALLOWLIST below. Mounted after the Better Auth
 * handler (`app.on(["GET","POST"], "/api/auth/*")`), so Better Auth endpoints answer before this
 * gate is reached and bypass it (including update-user, which cannot touch the flag: input:false).
 * Test accounts (SYNELIA_TEST_ACCOUNTS) are exempt.
 */
export const PASSWORD_CHANGE_ALLOWED = [
  "/api/auth/get-session",
  "/api/auth/change-password",
  "/api/auth/sign-out",
] as const;

export const PASSWORD_CHANGE_REQUIRED_BODY = {
  error: "Vous devez changer votre mot de passe.",
  code: "password_change_required",
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
      PASSWORD_CHANGE_ALLOWED.includes(
        path as (typeof PASSWORD_CHANGE_ALLOWED)[number],
      ) ||
      !(context.req.header("cookie") ?? "").includes("session_token")
    ) {
      return next();
    }
    const user = await lookup(context.req.raw.headers).catch(() => undefined);
    if (user?.mustChangePassword && !isTestAccount(user.id)) {
      return context.json(PASSWORD_CHANGE_REQUIRED_BODY, 403);
    }
    return next();
  };
}
