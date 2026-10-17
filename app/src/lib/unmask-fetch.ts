/**
 * Synelia fork: undo the server's 401 masking for EVERY same-origin fetch in the page.
 *
 * Behind Traefik basic auth the server never sends a raw 401 (Chrome would evict the tester's basic
 * credentials and loop on the prompt — server/src/synelia/basic-auth-safe.ts). It sends
 * `403 + x-synelia-status: 401` instead. Only that exact pair becomes a 401 again; a real 403 (the
 * forced password change, an admin-only route, …) is left a 403.
 *
 * Installed as a wrapper around `window.fetch` by importing this module first in main.tsx, so the
 * Better Auth client, the CopilotKit runtime (run / connect / SSE streams over fetch), `client()`
 * and the raw fetches all see the same status. There is no EventSource in the app; WebSocket
 * upgrades expose no status to script.
 *
 * Debt: remove with SYNELIA_MASK_401 (parity/matrice-parite.md).
 */
export const MASKED_STATUS_HEADER = "x-synelia-status";

export function isMasked401(response: Response): boolean {
  return (
    response.status === 403 &&
    response.headers.get(MASKED_STATUS_HEADER) === "401"
  );
}

/** The 401 the server meant; any other response is returned as it is (same object). */
export function unmaskStatus(response: Response): Response {
  if (!isMasked401(response)) return response;
  const restored = new Response(response.body, {
    status: 401,
    statusText: "Unauthorized",
    headers: response.headers,
  });
  // A constructed Response has an empty url; keep the original for callers that read it.
  if (response.url)
    Object.defineProperty(restored, "url", { value: response.url });
  return restored;
}

function sameOrigin(response: Response, origin: string | undefined): boolean {
  // Opaque or synthetic responses (no url) cannot be ours to rewrite unless the page has no origin.
  if (!response.url) return true;
  try {
    return new URL(response.url).origin === origin;
  } catch {
    return false;
  }
}

/** Wraps a fetch so same-origin masked 401s come back as 401. Idempotent. */
export function withUnmasking(
  base: typeof fetch,
  origin: () => string | undefined = () =>
    typeof window !== "undefined" ? window.location?.origin : undefined,
): typeof fetch {
  if ((base as { __syneliaUnmask?: true }).__syneliaUnmask) return base;
  const wrapped = (async (...args: Parameters<typeof fetch>) => {
    const response = await base(...args);
    return sameOrigin(response, origin()) ? unmaskStatus(response) : response;
  }) as typeof fetch & { __syneliaUnmask?: true };
  wrapped.__syneliaUnmask = true;
  return wrapped;
}

export function installUnmaskingFetch(target: typeof globalThis = globalThis) {
  if (typeof target.fetch !== "function") return;
  if ((target.fetch as { __syneliaUnmask?: true }).__syneliaUnmask) return;
  target.fetch = withUnmasking(target.fetch.bind(target));
}

installUnmaskingFetch();
