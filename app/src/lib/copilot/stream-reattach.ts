/**
 * Synelia fork: telling a cut stream from a failed run, and cleaning up after a reattach.
 *
 * A browser reports a dropped connection as a TypeError ("network error", "Failed to fetch",
 * "Load failed", "terminated", "ECONNRESET", "NetworkError when attempting to fetch resource").
 * A provider failure arrives as a RUN_ERROR event instead and never matches.
 */
const CUT =
  /network ?error|failed to fetch|load failed|terminated|econnreset|err_incomplete|connection (was )?(closed|reset)|body stream|aborted by the network/i;

export function isStreamCut(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError")
    return false;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  // Only the known network wordings: a TypeError from a bug in our own code is not a cut stream.
  return CUT.test(message);
}

/**
 * Synelia fork: the run was refused because this thread already has one going (lock 409, or the
 * runner's "already running"), e.g. a second click or a resend during a reconnect. Not a failure:
 * the page shows the running turn instead.
 */
export function isAlreadyRunning(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  // The explicit code from the server (409 body `{ error: "Thread is busy.", code: "thread_busy" }`,
  // carried by `client` errors and by a RUN_ERROR event's `code`), or the runner's own exact
  // sentences. Never a pattern on free text: a provider error mentioning "(HTTP 409)" is a failure.
  const code = (error as { code?: unknown }).code;
  if (code === "thread_busy") return true;
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : typeof (error as { message?: unknown }).message === "string"
          ? (error as { message: string }).message
          : "";
  return message === "Thread is busy." || message === "Thread already running";
}

/** Keep one message per id (the last version wins, in first-seen position). */
export function dedupeById<T extends { id: string }>(messages: T[]): T[] {
  const last = new Map<string, T>();
  for (const message of messages) last.set(message.id, message);
  if (last.size === messages.length) return messages;
  const seen = new Set<string>();
  const out: T[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    out.push(last.get(message.id) as T);
  }
  return out;
}

/**
 * Synelia fork: a run that finished without adding anything leaves the person's message last
 * (idempotent resend of an already answered message). The answer is on the server: replay it.
 */
export function endedWithoutAnswer(
  messages: readonly { role: string }[],
): boolean {
  return messages.at(-1)?.role === "user";
}
