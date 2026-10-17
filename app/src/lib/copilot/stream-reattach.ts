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
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const status = (error as { status?: number } | null)?.status;
  return (
    status === 409 ||
    /\b409\b|already running|thread is locked|lock conflict/i.test(message)
  );
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
