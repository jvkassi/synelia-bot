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
