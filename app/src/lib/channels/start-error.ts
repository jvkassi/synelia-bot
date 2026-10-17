import { redirectOnPasswordChange } from "@/lib/auth/password-change";
import { ui } from "@/lib/i18n";
import { CoworkerRoutingRefusedError } from "./route";

/**
 * Synelia fork: what the home page says when a conversation could not be started.
 *
 * `client()` throws the server's own `error` when it sent one, and the call site's fallback
 * otherwise; that fallback is exactly what reaches the screen when the answer did not come from the
 * app at all (a reverse-proxy 502/503/404 page while the server container restarts, a basic-auth
 * 401). So the sentence is chosen from the status and code, never from the message, and the status
 * and code ride along in parentheses so a tester's screenshot says which failure it was.
 */
type Failure = { status?: number; code?: string; name?: string };

function failureOf(error: unknown): Failure {
  if (typeof error !== "object" || error === null) return {};
  const { status, code, name } = error as Record<string, unknown>;
  return {
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof name === "string" ? { name } : {}),
  };
}

/** True for a request that never got an HTTP answer: offline, DNS, reset, or aborted. */
function isNetworkFailure(error: unknown, failure: Failure): boolean {
  return (
    failure.status === undefined &&
    (error instanceof TypeError || failure.name === "AbortError")
  );
}

/**
 * Synelia fork: the session is gone. The server's `code: "session_expired"` first (it survives the
 * 401 → 403 masking), then a plain 401. The home page then links to the sign-in screen.
 */
export function isSessionExpired(error: unknown): boolean {
  const { status, code } = failureOf(error);
  return code === "session_expired" || status === 401;
}

export function describeStartError(error: unknown): string {
  if (error instanceof CoworkerRoutingRefusedError) return error.message;
  const failure = failureOf(error);
  if (isNetworkFailure(error, failure)) return ui.home.networkError;
  const { status, code } = failure;
  if (status === undefined) return ui.home.startFailed;
  const detail = ui.home.errorDetail(status, code);
  // The sentence and « Se reconnecter » say it all: no technical suffix for a lost session.
  if (isSessionExpired(error)) return ui.home.sessionExpired;
  if (status === 403)
    return code === "password_change_required"
      ? ui.auth.changePasswordRequired
      : `${ui.home.accessDenied} ${detail}`;
  if (status >= 500 || (status === 404 && code === undefined))
    return `${ui.home.serviceUnavailable} ${detail}`;
  return `${ui.home.startFailed} ${detail}`;
}

/**
 * Logged for whoever reads the console or a tester's report: which step failed, with which status
 * and code. Never the message text the person typed.
 */
export function reportStartError(step: string, error: unknown): void {
  const failure = failureOf(error);
  redirectOnPasswordChange(error);
  console.warn("[synelia] home start failed", {
    step,
    status: failure.status ?? null,
    code: failure.code ?? null,
    network: isNetworkFailure(error, failure),
  });
}
