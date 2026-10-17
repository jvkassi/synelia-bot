/**
 * Synelia fork: the forced password change (first login). Rules, client validation and the mapping
 * of Better Auth's errors to French, kept apart from the screen so they are tested on their own.
 */
import { ui } from "@/lib/i18n";

/**
 * The server's rule, not ours: `emailAndPassword.minPasswordLength: 12` in
 * server/src/auth/index.ts. No endpoint the gate lets through (get-session, change-password,
 * sign-out) exposes it, so it is mirrored here; tests/synelia-change-password.test.tsx reads the
 * server file and fails if the two drift apart.
 */
export const PASSWORD_MIN_LENGTH = 12;
/** Better Auth's default `maxPasswordLength` (context/create-context.mjs), not overridden server-side. */
export const PASSWORD_MAX_LENGTH = 128;

export type PasswordField =
  | "currentPassword"
  | "newPassword"
  | "confirmPassword";
export type PasswordFieldErrors = Partial<Record<PasswordField, string>>;
export type PasswordChangeInput = Record<PasswordField, string>;

/** Client checks, in field order. Empty object: nothing to fix. */
export function validatePasswordChange(
  input: PasswordChangeInput,
  /** Forced change: the first field is the temporary password from the invitation. */
  temporary = false,
): PasswordFieldErrors {
  const errors: PasswordFieldErrors = {};
  if (!input.currentPassword)
    errors.currentPassword = temporary
      ? ui.auth.temporaryRequired
      : ui.auth.currentRequired;
  if (input.newPassword.length < PASSWORD_MIN_LENGTH)
    errors.newPassword = ui.auth.tooShort(PASSWORD_MIN_LENGTH);
  else if (input.newPassword.length > PASSWORD_MAX_LENGTH)
    errors.newPassword = ui.auth.tooLong(PASSWORD_MAX_LENGTH);
  else if (input.currentPassword && input.newPassword === input.currentPassword)
    errors.newPassword = temporary
      ? ui.auth.sameAsTemporary
      : ui.auth.sameAsCurrent;
  if (!input.confirmPassword) errors.confirmPassword = ui.auth.confirmRequired;
  else if (input.confirmPassword !== input.newPassword)
    errors.confirmPassword = ui.auth.mismatch;
  return errors;
}

/**
 * What Better Auth's client hands back on failure: `{ error: { code?, message?, status, statusText } }`.
 * The server builds it with `APIError.from("BAD_REQUEST", BASE_ERROR_CODES.X)`, whose body is
 * `{ code: "X", message }` (better-auth 1.7.1 api/routes/update-user.mjs:160-178).
 */
export type BetterAuthError = {
  code?: string;
  message?: string;
  status?: number;
  statusText?: string;
};

/** Where a server refusal is shown: on a field when it is about one, else only in the summary. */
export function mapChangePasswordError(
  error: unknown,
  temporary = false,
): {
  field?: PasswordField;
  message: string;
} {
  if (error instanceof TypeError) return { message: ui.auth.networkError };
  const { code, status } = (error ?? {}) as BetterAuthError;
  switch (code) {
    case "INVALID_PASSWORD":
      return {
        field: "currentPassword",
        message: temporary ? ui.auth.invalidTemporary : ui.auth.invalidCurrent,
      };
    case "PASSWORD_TOO_SHORT":
      return {
        field: "newPassword",
        message: ui.auth.tooShort(PASSWORD_MIN_LENGTH),
      };
    case "PASSWORD_TOO_LONG":
      return {
        field: "newPassword",
        message: ui.auth.tooLong(PASSWORD_MAX_LENGTH),
      };
  }
  if (status === 429) return { message: ui.auth.tooManyAttempts };
  if (status === 503) return { message: ui.auth.serviceUnavailable };
  // better-fetch reports a request that never got an answer with no HTTP status.
  if (status === 0) return { message: ui.auth.networkError };
  return { message: ui.auth.changeFailed };
}
