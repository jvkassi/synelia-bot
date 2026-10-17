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
import { type BaseEvent, compactEvents } from "@ag-ui/client";

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
  if (list.some((event) => TOOL_TYPES.has(event.type ?? "")))
    return "tool_call";
  if (list.some((event) => TEXT_TYPES.has(event.type ?? ""))) return "stop";
  if (list.some((event) => event.type === "RUN_FINISHED"))
    return SYNELIA_ERROR_CODES.providerRefusal;
  return "unknown";
}

/**
 * THE SINGLE REFUSAL DECISION, shared by the live stream and persistence so they never diverge.
 * Returns why a FINISHED run is actually a silent provider refusal, or undefined when it is a real
 * answer:
 *  - "empty_finish": finished with no text and no tool call.
 *  - "usage0": finished with text, no tool call, usage PRESENT == 0, on an allowlisted provider+model
 *    (off by default; see usage0Refusal). A run already carrying a RUN_ERROR is never a candidate.
 * Pure and total.
 */
export function refusalReason(
  events: readonly BaseEvent[],
  context: { provider?: string; model?: string } = {},
  allowlist: ReadonlySet<string> = usage0Allowlist(),
): "empty_finish" | "usage0" | undefined {
  const list = events as readonly Eventish[];
  const hasFinished = list.some((event) => event.type === "RUN_FINISHED");
  const hasError = list.some((event) => event.type === "RUN_ERROR");
  const hasText = list.some((event) => TEXT_TYPES.has(event.type ?? ""));
  const hasTool = list.some((event) => TOOL_TYPES.has(event.type ?? ""));
  if (hasFinished && !hasError && !hasText && !hasTool) return "empty_finish";
  if (usage0Refusal(events, context, allowlist)) return "usage0";
  return undefined;
}

/**
 * Adjust a finished run's events before they are persisted, and say what status to store.
 *
 *  - A run that FINISHED with no text and no tool call is a silent provider refusal: its
 *    RUN_FINISHED is REPLACED by a RUN_ERROR { message: "content_filter", code: "provider_refusal",
 *    metadata: { reason: "empty_finish" } }.
 *  - A run that FINISHED with text, no tool call, and usage PRESENT and == 0 on an ALLOWLISTED
 *    provider+model (usage0Refusal, off by default) is the "model wrote an English refusal" shape:
 *    its RUN_FINISHED is REPLACED by a RUN_ERROR { code: "provider_refusal", metadata: { reason:
 *    "usage0" } }. The TEXT events are KEPT in storage (not dropped) so a false positive can be
 *    audited later; the single replay rule (replayEvents) hides them on reload. The `reason` field
 *    makes the trigger countable straight from the DB (no need to parse docker logs).
 *  - Any RUN_ERROR without a code gets a stable one (refusal vs unavailable).
 *  - Once a run carries a RUN_ERROR, every RUN_FINISHED is dropped: AG-UI treats RUN_ERROR as the
 *    terminal event, and a stored run must never carry both, whichever order they arrived in.
 *
 * Pure and total, so the whole decision is unit-testable without a database. `context` (the resolved
 * provider+model) is needed only for the usage0 rule; omit it and only the empty-finish rule applies.
 */
export function adjustPersistedRun(
  events: readonly BaseEvent[],
  context: { provider?: string; model?: string } = {},
  allowlist: ReadonlySet<string> = usage0Allowlist(),
): {
  events: BaseEvent[];
  status: "done" | "error";
} {
  const list = events as readonly Eventish[];
  // THE ONE DECISION. The live stream (postgres-runner run()) and this persisted adjustment both call
  // refusalReason with the same resolved provider/model, so they can never diverge.
  const reason = refusalReason(events, context, allowlist);

  let next = events.map((event) => {
    const value = event as Eventish;
    if (value.type !== "RUN_ERROR") return event;
    if (typeof value.code === "string" && value.code) return event;
    const message = typeof value.message === "string" ? value.message : "";
    return { ...event, code: classifyErrorCode(message) } as BaseEvent;
  });

  if (reason) {
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
            metadata: { reason, retryable: computeRetryable(events) },
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

/**
 * EFFECTFUL TOOLS — a CLOSED list of tools whose side effect a retry would duplicate. Today only
 * `report_refusal`, which writes one `bot.declined` audit row (agents/routes.ts `/:agentId/declined`).
 * The in-chat ask/show components (askApproval, showTable, …) are display only and are deliberately
 * NOT listed. A tool absent from this set is treated as retry-safe.
 */
export const EFFECTFUL_TOOLS: ReadonlySet<string> = new Set(["report_refusal"]);

/**
 * Whether a failed / refused run may be retried by resending the same message. DERIVED AT READ TIME
 * from the run's own TOOL_CALL_START events against the closed list above, and NEVER trusted from
 * any stored `metadata.retryable` (a run persisted before this hash carries none). A run that
 * performed an effectful tool call is not retryable: resending it would run the side effect again.
 * Both `lastRunError` and `connect` replay call this one function, so a reload and a live reconnect
 * agree, and a legacy run with an effectful tool call comes out `false`.
 */
export function computeRetryable(
  events: readonly BaseEvent[],
  effectful: ReadonlySet<string> = EFFECTFUL_TOOLS,
): boolean {
  const list = events as readonly { type?: string; toolCallName?: unknown }[];
  for (const event of list) {
    if (event.type !== "TOOL_CALL_START") continue;
    const name =
      typeof event.toolCallName === "string" ? event.toolCallName : "";
    if (effectful.has(name)) return false;
  }
  return true;
}

/** The RUN_FINISHED usage's outputTokens, whether usage is stored as an array or a lone object. */
export function finishedOutputTokens(
  events: readonly BaseEvent[],
): number | undefined {
  const finished = (
    events as readonly { type?: string; usage?: unknown }[]
  ).find((event) => event.type === "RUN_FINISHED");
  const usage = finished?.usage;
  const entry = Array.isArray(usage) ? usage[0] : usage;
  const out = (entry as { outputTokens?: unknown } | undefined)?.outputTokens;
  return typeof out === "number" ? out : undefined;
}

/**
 * Provider+model pairs (`provider:model`) where a finished run with `outputTokens === 0` AND readable
 * text is a proven silent refusal. DISABLED by default (empty set): konnect 2026-10-17 showed
 * router9 `cc/claude-sonnet-5-5` gives 0 output tokens on 3/3 content-policy refusals and >0 on 46/46
 * normal answers, but one of those refusals landed at 17:30 — beyond the 17:21 phishing pair the
 * review named — so the signal is not yet enabled for text-bearing runs. Set
 * SYNELIA_REFUSAL_USAGE0_MODELS (comma-separated) to turn it on once a replay-time text filter ships.
 */
export function usage0Allowlist(
  raw: string | undefined = process.env.SYNELIA_REFUSAL_USAGE0_MODELS,
): ReadonlySet<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

/**
 * Whether a finished run on an ALLOWLISTED provider+model, with 0 output tokens and non-empty text,
 * is a candidate silent refusal. Used only to LOG the trigger (provider, model, usage, text) so
 * false positives can be counted; it never drops the text here. Returns false for an empty allowlist
 * (the default), a non-allowlisted pair, absent usage, usage > 0, or empty text — so a genuine short
 * answer with normal usage is never flagged and usage 0 on a non-allowlisted model never triggers.
 */
export function usage0Refusal(
  events: readonly BaseEvent[],
  context: { provider?: string; model?: string },
  allowlist: ReadonlySet<string> = usage0Allowlist(),
): boolean {
  // Disabled unless the allowlist names this pair, by EXACT `provider:model` match — never a prefix,
  // so cc/claude-sonnet-5-6 does not match an allowlisted cc/claude-sonnet-5-5.
  if (allowlist.size === 0) return false;
  if (!context.provider || !context.model) return false;
  if (!allowlist.has(`${context.provider}:${context.model}`)) return false;
  const list = events as readonly Eventish[];
  // Only a clean finish with text and NO tool call: a tool call means the model acted, not a silent
  // refusal, and an already-errored run is left to the other rules.
  if (!list.some((event) => event.type === "RUN_FINISHED")) return false;
  if (list.some((event) => event.type === "RUN_ERROR")) return false;
  if (!list.some((event) => TEXT_TYPES.has(event.type ?? ""))) return false;
  if (list.some((event) => TOOL_TYPES.has(event.type ?? ""))) return false;
  // usage must be PRESENT and exactly 0; absent (undefined) never triggers — a 5369-char answer with
  // usage absent was a real answer on this path (konnect 2026-10-17).
  return finishedOutputTokens(events) === 0;
}

/** Assistant OUTPUT events (streamed text, tool calls). Dropped on replay for a suppressed run so a
 * reload shows no English refusal text; the user's message (carried by the messages snapshot/route)
 * and the terminal RUN_ERROR stay. */
const ASSISTANT_OUTPUT_TYPES = new Set([
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_CHUNK",
  "TEXT_MESSAGE_END",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_CHUNK",
  "TOOL_CALL_END",
  "TOOL_CALL_RESULT",
]);

/**
 * THE SINGLE REPLAY RULE (connect / reload). Given a thread's historic runs oldest-first, produce the
 * event stream a reconnecting browser replays. One run's assistant output is DROPPED when the run is
 * either a SUPERSEDED error run (it ended in error and a later run exists) OR a provider_refusal run
 * (even as the last run): the front renders the French notice from the RUN_ERROR `code` instead of the
 * provider's English text. Every replayed RUN_ERROR is stamped with `metadata.retryable`, recomputed
 * from that run's own tool calls (computeRetryable), overwriting any stored value — so a reload and a
 * live reconnect agree and a legacy run with an effectful tool comes out not retryable. Pure and
 * total: one function, covered by one shared test, used by connect() in postgres-runner.ts.
 */
export function replayEvents(
  runs: readonly { events: readonly BaseEvent[] }[],
  effectful: ReadonlySet<string> = EFFECTFUL_TOOLS,
): BaseEvent[] {
  const out: BaseEvent[] = [];
  runs.forEach((run, index) => {
    const events = run.events as readonly Eventish[];
    const errorEvent = events.find((event) => event.type === "RUN_ERROR");
    const isLast = index === runs.length - 1;
    const suppressed =
      !!errorEvent &&
      (!isLast || errorEvent.code === SYNELIA_ERROR_CODES.providerRefusal);
    const retryable = computeRetryable(run.events, effectful);
    for (const event of run.events) {
      const type = (event as Eventish).type ?? "";
      if (suppressed && ASSISTANT_OUTPUT_TYPES.has(type)) continue;
      if (type === "RUN_ERROR") {
        const previous = (event as { metadata?: Record<string, unknown> })
          .metadata;
        out.push({
          ...event,
          metadata: { ...(previous ?? {}), retryable },
        } as BaseEvent);
      } else out.push(event);
    }
  });
  return compactEvents(out);
}
