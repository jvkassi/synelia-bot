/**
 * Synelia fork: what the transcript says when a turn ends without an answer.
 *
 * `stopped` (channel-chat.tsx → ChatTranscript) carries whatever ended the turn in that thing's own
 * words: the patched Mastra bridge's provider message (`… (HTTP 403)`, raw and usually English), an
 * AI SDK error from a stream chunk (no status at all), the stall watchdog's English sentence
 * (server/src/channels/stall-guard.ts), a browser TypeError, or one of the app's own French
 * sentences. Testers read French; a raw provider message is never put on screen. It goes to the
 * console instead (see `Stopped` in chat-transcript.tsx), and the run row keeps it server-side.
 */
import { ui } from "@/lib/i18n";

/**
 * Set as the turn's `stopped` reason when the run FINISHED cleanly with nothing in it: no text, no
 * tool call, the person's message still last after the replay. That is what a provider refusal
 * looks like on this stack today: a content filter ends the completion with `finish_reason:
 * "content_filter"` (or Anthropic's `refusal`) and no content, and the bridge turns that into a bare
 * RUN_FINISHED (it never reads the finish reason). Not a sentence, so it can never be shown as one.
 */
export const EMPTY_RUN = "synelia:empty-run";

export type StopNotice = {
  text: string;
  /** `status` for a refusal (an answer, of sorts); `alert` for a failure. */
  role: "status" | "alert";
  /** The raw reason is technical and goes to the console, never to the screen. */
  technical: boolean;
  /**
   * « Réessayer » is offered: the same turn is run again on the message already in the thread.
   * Never for a refusal (the same words get the same answer; the server would also answer an
   * already-finished message with an empty run) nor while the run may still be going server-side.
   */
  retry: boolean;
};

/**
 * STABLE SERVER CODES, read before any wording. Carried on a RUN_ERROR event's `code`
 * (channel-chat.tsx `onRunErrorEvent`) or on the stored run's `lastError.code` (GET
 * /api/threads/:id, `threadStatusView` in synelia-model.tsx). `AGENT_STREAM_STALLED` is the code the
 * stall watchdog already sends (server/src/channels/stall-guard.ts), read as `run_stalled`.
 */
const CODE_PREFIX = "synelia:code:";
const KNOWN_CODES: Record<
  string,
  | "provider_refusal"
  | "run_stalled"
  | "provider_unavailable"
  | "session_expired"
> = {
  provider_refusal: "provider_refusal",
  run_stalled: "run_stalled",
  AGENT_STREAM_STALLED: "run_stalled",
  provider_unavailable: "provider_unavailable",
  session_expired: "session_expired",
};

/**
 * The `stopped` reason for a turn: a known server code wins (encoded, never shown), otherwise the
 * message as the server wrote it, for the fallback heuristics below.
 */
export function codedReason(code: unknown, message: unknown): string | null {
  if (typeof code === "string" && KNOWN_CODES[code])
    return `${CODE_PREFIX}${KNOWN_CODES[code]}`;
  return typeof message === "string" && message.trim() ? message : null;
}

/**
 * The server's own 401 bodies (server/src/copilot.ts « Sign in to use this deployment. », the
 * `requireUser` guard in server/src/auth/guards.ts « Authentication required. »). Masking leaves the
 * body untouched (server/src/synelia/basic-auth-safe.ts), so a 403 carrying one of these IS a masked
 * 401. Needed because the run's HTTP error keeps the status and body but not the headers (below).
 */
const SERVER_401_BODIES = new Set([
  "Sign in to use this deployment.",
  "Authentication required.",
]);

/**
 * A run refused because the session is gone: HTTP 401, or the 403 + `x-synelia-status: 401` the
 * server sends instead behind the basic-auth proxy (app/src/lib/client.ts `unmaskStatus`).
 *
 * WHAT THE RUN'S ERROR CARRIES. CopilotKit 1.77 sends runs through `@ag-ui/client`'s
 * `runHttpRequest`; on a non-OK response it throws `Error("HTTP <status>: <body>")` with `.status`
 * and `.payload` (the parsed JSON body) and DROPS the headers, and that same Error reaches
 * `onRunFailed`. So the `x-synelia-status` header is read here only if a future runtime exposes it
 * (`error.headers` / `error.response.headers`); today the masked 401 is recognised by its body.
 * A plain 403 (`password_change_required`, …) is not this and keeps its usual handling.
 */
export function sessionExpiredReason(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const failure = error as {
    status?: unknown;
    payload?: unknown;
    message?: unknown;
    headers?: { get?: (name: string) => string | null };
    response?: { headers?: { get?: (name: string) => string | null } };
  };
  const statusFromMessage =
    typeof failure.message === "string"
      ? /^HTTP (\d{3}):/.exec(failure.message)?.[1]
      : undefined;
  const status =
    typeof failure.status === "number"
      ? failure.status
      : statusFromMessage
        ? Number(statusFromMessage)
        : undefined;
  const expired = `${CODE_PREFIX}session_expired`;
  if (status === 401) return expired;
  if (status !== 403) return null;
  const headers = failure.headers ?? failure.response?.headers;
  if (headers?.get?.("x-synelia-status") === "401") return expired;
  const said =
    typeof failure.payload === "object" && failure.payload !== null
      ? (failure.payload as { error?: unknown }).error
      : undefined;
  return typeof said === "string" && SERVER_401_BODIES.has(said)
    ? expired
    : null;
}

/** The browser's own wording for a request that never got an answer, across engines. */
export function isNetworkFailure(reason: string): boolean {
  return /^(TypeError:\s*)?(network ?error|failed to fetch|load failed|networkerror when attempting to fetch resource\.?)$/i.test(
    reason.trim(),
  );
}

/** A provider failure as the patched bridge words it: status suffix, or its own fallback. */
export function isProviderError(reason: string): boolean {
  return /\(HTTP \d{3}\)\s*$|^Erreur du fournisseur/.test(reason);
}

/**
 * A provider declining the request rather than failing: moderation (OpenRouter 403 « flagged »),
 * a content filter, Anthropic's `refusal`, a usage-policy answer. Deliberately not plain « refused »,
 * which is also how a closed port reads (« refused the connection »).
 */
export function isProviderRefusal(reason: string): boolean {
  return /\brefusal\b|content[\s_-]?filter|moderation|flagged|safety (filter|system|polic)|(usage|content) polic|policy violation|violates?\b.*polic/i.test(
    reason,
  );
}

/** The stall watchdog's sentence (server/src/channels/stall-guard.ts `stalledEvent`). */
export function isStall(reason: string): boolean {
  return /stopped responding\. Nothing arrived from it/.test(reason);
}

/** The app's own French sentences: these are already written for a person and pass through. */
function isOwnSentence(reason: string): boolean {
  return Object.values(ui.conversation).some((value) => value === reason);
}

/**
 * The model to suggest instead of the one that refused: « Alternatif » when it exists and is not the
 * one in use, else any other available model, else none (the sentence then says « un autre »).
 */
export function alternativeModel(
  models: readonly { id: string; label?: string | null }[] | undefined,
  selected: string | undefined,
): string | null {
  const others = (models ?? []).filter(
    (model) => model.id !== selected && model.label,
  );
  const preferred =
    others.find((model) => model.label === "Alternatif") ?? others[0];
  return preferred?.label ?? null;
}

/**
 * The server marks a failed run `retryable: false` (RUN_ERROR event, stored `lastError`) when it
 * contains a side-effect tool call (`report_refusal` included): running it again would repeat the
 * effect. Carried on the reason as a prefix, so the live and the reload paths decide alike.
 */
const NO_RETRY_PREFIX = "synelia:no-retry:";

/** `reason`, marked not retryable when the server said `retryable: false` (only `false` counts). */
export function withRetryable(
  reason: string | null,
  retryable: unknown,
): string | null {
  return reason !== null && retryable === false
    ? `${NO_RETRY_PREFIX}${reason}`
    : reason;
}

export function stopNotice(
  reason: string,
  alternative: string | null,
): StopNotice {
  if (reason.startsWith(NO_RETRY_PREFIX)) {
    const inner = stopNotice(reason.slice(NO_RETRY_PREFIX.length), alternative);
    // A failure that offered « Réessayer » says how to go on instead; a notice that never offered
    // it (refusal, expired session, network) is already the right sentence.
    return inner.retry
      ? {
          text: ui.conversation.runFailedNoRetry,
          role: "alert",
          technical: inner.technical,
          retry: false,
        }
      : inner;
  }
  const declined = (technical: boolean): StopNotice => ({
    text: ui.conversation.declined(alternative),
    role: "status",
    technical,
    retry: false,
  });
  const failed = (technical: boolean): StopNotice => ({
    text: ui.conversation.runFailed,
    role: "alert",
    technical,
    retry: true,
  });
  const unavailable = (technical: boolean): StopNotice => ({
    text: ui.conversation.modelUnavailable,
    role: "alert",
    technical,
    retry: true,
  });
  if (reason === EMPTY_RUN) return declined(false);
  if (reason.startsWith(CODE_PREFIX)) {
    const code = reason.slice(CODE_PREFIX.length);
    if (code === "provider_refusal") return declined(false);
    if (code === "provider_unavailable") return unavailable(false);
    // Signed out: say so, and no « Réessayer » (it would be refused the same way).
    if (code === "session_expired")
      return {
        text: ui.home.sessionExpired,
        role: "alert",
        technical: false,
        retry: false,
      };
    return failed(false);
  }
  // Nothing was reported: the generic failure, with its retry.
  if (reason === ui.conversation.stoppedWithoutReason) return failed(false);
  // The app's own French sentences (« Rechargez la page », « Renvoyez votre message »): already
  // written for a person, and each says what to do, so no button competes with it.
  if (isOwnSentence(reason))
    return { text: reason, role: "alert", technical: false, retry: false };
  /*
   * TEMPORARY FALLBACK: wording heuristics for a RUN_ERROR that carries no code. Delete this block
   * once the server emits `provider_refusal` / `run_stalled` / `provider_unavailable` on every
   * RUN_ERROR and on the stored `lastError` (see the codes above).
   */
  if (isNetworkFailure(reason))
    // The stream dropped but the run goes on server-side: a retry would race it.
    return {
      text: ui.conversation.networkError,
      role: "alert",
      technical: true,
      retry: false,
    };
  if (isStall(reason)) return failed(true);
  if (isProviderRefusal(reason)) return declined(true);
  if (isProviderError(reason)) return unavailable(true);
  return failed(true);
}
