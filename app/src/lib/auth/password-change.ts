/**
 * Synelia fork: forced password change at first login. While the account's flag is set the server
 * answers 403 `{ code: "password_change_required" }` on every API call except get-session,
 * change-password and sign-out (server/src/synelia/password-change-gate.ts); the app goes to
 * /change-password. Contract for the form: `authClient.changePassword({ currentPassword,
 * newPassword, revokeOtherSessions: true })`; on success the server clears the flag.
 */
export const PASSWORD_CHANGE_REQUIRED = "password_change_required";
export const CHANGE_PASSWORD_PATH = "/change-password";

export function isPasswordChangeRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === PASSWORD_CHANGE_REQUIRED
  );
}

/** Global handler (query and mutation caches): one navigation, never a loop on the page itself. */
export function redirectOnPasswordChange(
  error: unknown,
  location: Pick<Location, "pathname" | "assign"> = window.location,
): boolean {
  if (!isPasswordChangeRequired(error)) return false;
  if (location.pathname !== CHANGE_PASSWORD_PATH)
    location.assign(CHANGE_PASSWORD_PATH);
  return true;
}
