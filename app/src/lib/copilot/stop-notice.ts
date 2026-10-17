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
};

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

export function stopNotice(
  reason: string,
  alternative: string | null,
): StopNotice {
  if (reason === EMPTY_RUN)
    return {
      text: ui.conversation.declined(alternative),
      role: "status",
      technical: false,
    };
  if (isOwnSentence(reason))
    return { text: reason, role: "alert", technical: false };
  if (isNetworkFailure(reason))
    return {
      text: ui.conversation.networkError,
      role: "alert",
      technical: true,
    };
  if (isStall(reason))
    return { text: ui.conversation.stalled, role: "alert", technical: true };
  if (isProviderRefusal(reason))
    return {
      text: ui.conversation.declined(alternative),
      role: "status",
      technical: true,
    };
  if (isProviderError(reason))
    return {
      text: ui.conversation.modelUnavailable,
      role: "alert",
      technical: true,
    };
  return {
    text: ui.conversation.runFailed(alternative),
    role: "alert",
    technical: true,
  };
}
