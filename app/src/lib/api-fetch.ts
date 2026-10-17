import { apiUrl } from "@/lib/api-url";
import { unmaskStatus } from "@/lib/unmask-fetch";

/**
 * Synelia fork: the transport for direct same-origin API fetches (the calls that do not go through
 * `client()`): the URL goes through `apiUrl` (credential-safe; idempotent for an absolute URL) and the
 * response through `unmaskStatus` (403 + x-synelia-status: 401 → 401, nothing else touched). Does not
 * depend on the global wrapper installed by main.tsx.
 *
 * Not covered: the CopilotKit runtime / @ag-ui/client transport, which exposes only `.status` and
 * `.payload` (no headers) to the app — it relies on the global wrapper (lib/unmask-fetch.ts).
 */
export async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return unmaskStatus(await fetch(apiUrl(input), init));
}
