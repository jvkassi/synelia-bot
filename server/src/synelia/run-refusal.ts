/**
 * Synelia fork: turn a run that a provider silently refused into a persisted error with a stable
 * code, and give every persisted RUN_ERROR a stable code the front can map without reading English.
 *
 * WHY THIS LIVES AT PERSIST TIME, not on the live stream. The browser already copes with an empty
 * refusal live: channel-chat.tsx sees RUN_FINISHED with no text and no tool call and shows the
 * French « declined » notice (see EMPTY_RUN in lib/copilot/stop-notice.ts). What it could NOT do is
 * survive a reload: the run was stored with status "done" and a bare RUN_FINISHED, so
 * `lastRunError` returned nothing and the notice vanished. The events the runtime records come from
 * the raw bridge stream, so the fix is to adjust what gets WRITTEN: an empty finish becomes a
 * RUN_ERROR carrying `code: "provider_refusal"`, and `postgres-runner.ts` then stores status error
 * (it already does for any RUN_ERROR) and `lastRunError` returns the code.
 *
 * WHAT A PROVIDER REFUSAL LOOKS LIKE HERE (konnect, 2026-10-17, phishing e2e prompt through 9router
 * → Anthropic): two shapes were seen. The model that writes an English refusal AS TEXT
 * (`finish_reason: stop`, 0 output tokens, readable content) is a prompt matter and is left alone —
 * it is a normal, non-empty answer on this path. The shape this file catches is the other one: a
 * content filter that ends the completion with no content at all (`finish_reason: content_filter`
 * or Anthropic `refusal`), which the AG-UI bridge turns into a bare RUN_FINISHED because it never
 * reads the finish reason. The finish reason itself is not carried on any AG-UI event, so the
 * reliable, provider-agnostic signal is exactly "finished, no text, no tool call". The raw
 * finish_reason is logged separately at the provider boundary (agent-mastra timedFetch).
 */
import type { BaseEvent } from "@ag-ui/client";

/** Stable error codes the front maps to French, preferred over any regex on the message. */
export const SYNELIA_ERROR_CODES = {
  /** A content filter / moderation / refusal, including an empty finish. */
  providerRefusal: "provider_refusal",
  /** The provider could not answer (HTTP error, gateway, auth). */
  providerUnavailable: "provider_unavailable",
  /** The stall watchdog ended the turn (alias of stall-guard's AGENT_STREAM_STALLED). */
  runStalled: "run_stalled",
} as const;

type Eventish = {
  type?: string;
  code?: unknown;
  message?: unknown;
  threadId?: unknown;
  runId?: unknown;
};

const TEXT_TYPES = new Set(["TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CHUNK"]);
const TOOL_TYPES = new Set(["TOOL_CALL_START", "TOOL_CALL_CHUNK"]);

/** Refusal wording from a provider/bridge message (English): content filter, moderation, policy. */
function looksLikeRefusal(message: string): boolean {
  return /\brefusal\b|content[\s_-]?filter|moderation|flagged|safety (filter|system|polic)|(usage|content) polic|policy violation|violates?\b.*polic/i.test(
    message,
  );
}

/** A provider failure as the patched bridge words it: an HTTP status suffix, or its own fallback. */
function looksLikeProviderError(message: string): boolean {
  return /\(HTTP \d{3}\)\s*$|^Erreur du fournisseur|^Provider error/i.test(
    message,
  );
}

/**
 * The stable code for a RUN_ERROR that arrived WITHOUT one. A refusal wins over a plain provider
 * error (a 403 « flagged » reads as both), otherwise it is provider_unavailable. A RUN_ERROR that
 * already carries a code (thread_busy, AGENT_STREAM_STALLED, provider_authentication_failed, …) is
 * never overwritten.
 */
export function classifyErrorCode(message: string): string {
  if (looksLikeRefusal(message)) return SYNELIA_ERROR_CODES.providerRefusal;
  if (looksLikeProviderError(message))
    return SYNELIA_ERROR_CODES.providerUnavailable;
  return SYNELIA_ERROR_CODES.providerUnavailable;
}

/** A compact classification of how a run ended, for the per-run timing log (never content). */
export function finishClass(events: readonly BaseEvent[]): string {
  const list = events as readonly Eventish[];
  const error = list.find((event) => event.type === "RUN_ERROR");
  if (error)
    return typeof error.code === "string" && error.code
      ? error.code
      : "run_error";
  if (list.some((event) => TOOL_TYPES.has(event.type ?? ""))) return "tool_call";
  if (list.some((event) => TEXT_TYPES.has(event.type ?? ""))) return "stop";
  if (list.some((event) => event.type === "RUN_FINISHED"))
    return SYNELIA_ERROR_CODES.providerRefusal;
  return "unknown";
}

/**
 * Adjust a finished run's events before they are persisted, and say what status to store.
 *
 *  - A run that FINISHED with no text and no tool call is a silent provider refusal: its
 *    RUN_FINISHED is REPLACED by a RUN_ERROR { message: "content_filter", code: "provider_refusal" }.
 *  - Any RUN_ERROR without a code gets a stable one (refusal vs unavailable).
 *  - Once a run carries a RUN_ERROR, every RUN_FINISHED is dropped: AG-UI treats RUN_ERROR as the
 *    terminal event, and a stored run must never carry both, whichever order they arrived in.
 *
 * Pure and total, so the whole decision is unit-testable without a database.
 */
export function adjustPersistedRun(events: readonly BaseEvent[]): {
  events: BaseEvent[];
  status: "done" | "error";
} {
  const list = events as readonly Eventish[];
  const hasFinished = list.some((event) => event.type === "RUN_FINISHED");
  const hasError = list.some((event) => event.type === "RUN_ERROR");
  const hasText = list.some((event) => TEXT_TYPES.has(event.type ?? ""));
  const hasTool = list.some((event) => TOOL_TYPES.has(event.type ?? ""));

  const emptyRefusal = hasFinished && !hasError && !hasText && !hasTool;

  let next = events.map((event) => {
    const value = event as Eventish;
    if (value.type !== "RUN_ERROR") return event;
    if (typeof value.code === "string" && value.code) return event;
    const message = typeof value.message === "string" ? value.message : "";
    return { ...event, code: classifyErrorCode(message) } as BaseEvent;
  });

  if (emptyRefusal) {
    const finished = list.find((event) => event.type === "RUN_FINISHED");
    next = next.map((event) =>
      (event as Eventish).type === "RUN_FINISHED"
        ? ({
            type: "RUN_ERROR",
            ...(typeof finished?.threadId === "string"
              ? { threadId: finished.threadId }
              : {}),
            ...(typeof finished?.runId === "string"
              ? { runId: finished.runId }
              : {}),
            message: "content_filter",
            code: SYNELIA_ERROR_CODES.providerRefusal,
          } as BaseEvent)
        : event,
    );
  }

  const nowHasError = next.some(
    (event) => (event as Eventish).type === "RUN_ERROR",
  );
  if (nowHasError)
    next = next.filter((event) => (event as Eventish).type !== "RUN_FINISHED");

  return { events: next, status: nowHasError ? "error" : "done" };
}
