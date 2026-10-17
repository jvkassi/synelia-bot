/**
 * Synelia fork: the address of a same-origin API call, safe when the page URL carries credentials.
 *
 * The pilot sits behind a reverse proxy with basic auth, and a tester can open it as
 * `https://user:pass@host/…`. The document URL then carries that userinfo, every relative `fetch`
 * resolves against it, and the Fetch spec refuses the result: « Request cannot be constructed from
 * a URL that includes credentials: /api/me ». `location.origin` never includes userinfo, so a path
 * prefixed with it is the same request without the credentials in the URL (the browser still sends
 * the cached basic-auth header for the origin).
 *
 * Only that case is rewritten. A page without userinfo keeps the relative path byte for byte, so
 * nothing changes for the usual load, the Vite dev proxy, or the suites that match on `/api/...`.
 * Absolute and protocol-relative inputs are returned as they are: this helper never picks a host.
 */
type PageLocation = Pick<Location, "href" | "origin">;

function currentLocation(): PageLocation | undefined {
  return typeof window !== "undefined" && window.location
    ? window.location
    : undefined;
}

/** True when the page's own URL has a username or a password in it. */
export function pageUrlHasCredentials(
  location: PageLocation | null | undefined = currentLocation(),
): boolean {
  if (!location?.href) return false;
  try {
    const url = new URL(location.href);
    return url.username !== "" || url.password !== "";
  } catch {
    return false;
  }
}

export function apiUrl(
  path: string,
  /** `null`: no page at all (SSR, a server-side test). Defaults to `window.location` when there is one. */
  location: PageLocation | null | undefined = currentLocation(),
): string {
  // Only a root-relative path is ours to anchor; `//host/x` would name another host.
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  if (!location?.origin || location.origin === "null") return path;
  if (!pageUrlHasCredentials(location)) return path;
  // Concatenated, not `new URL(path, origin)`: the path (and its %xx escapes) reaches the server
  // exactly as the caller wrote it, which is what the pilot's canonical-path gate compares.
  return `${location.origin}${path}`;
}
