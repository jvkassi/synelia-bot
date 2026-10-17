/**
 * Synelia fork: what « Réessayer » runs again after a failed turn.
 *
 * A turn can fail after the assistant started writing: the thread then ends with the person's
 * message followed by a partial answer (text, and perhaps tool calls and their results) from the
 * failed run. Re-running on that as-is would hand the model its own half-answer to continue, so the
 * retry cuts the thread back to the person's message and runs from there; every earlier message
 * keeps its id. When the trailing messages cannot be shown to come from the failed run, there is
 * no clean retry and the button is not offered (never a silent no-op).
 */

/** Roles a failed run can leave behind the person's message. */
const RUN_OUTPUT_ROLES = new Set([
  "assistant",
  "tool",
  "reasoning",
  "activity",
]);

/**
 * How many messages the retry keeps: up to and including the last user message. `null` when no
 * clean retry exists.
 *
 * @param idsBeforeRun ids in the thread just before the failed run started (null when this tab
 *   did not start it, e.g. after a reload): anything after the person's message that is not in it
 *   is output of that run.
 */
export function retryKeepCount(
  messages: readonly { id: string; role: string }[],
  idsBeforeRun: ReadonlySet<string> | null,
): number | null {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) return null;
  const keep = lastUser + 1;
  if (keep === messages.length) return keep;
  if (!idsBeforeRun?.has(messages[lastUser]?.id ?? "")) return null;
  const fromFailedRun = messages
    .slice(keep)
    .every(
      (message) =>
        RUN_OUTPUT_ROLES.has(message.role) && !idsBeforeRun.has(message.id),
    );
  return fromFailedRun ? keep : null;
}
