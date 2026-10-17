/**
 * Synelia fork: time-to-first-text marks for the home → conversation path, off by default.
 *
 * On in a Vite dev build, or in any build with `localStorage.setItem("synelia.perf", "1")` (then
 * reload). Each mark is a `performance.mark("synelia:<name>")` (visible in the Performance panel)
 * and a console line with the time since the last `home:submit`. Off, every call is a no-op.
 */
const STORAGE_KEY = "synelia.perf";
const SUBMIT = "synelia:home:submit";

function enabled(): boolean {
  try {
    const env = (import.meta as { env?: { DEV?: boolean } }).env;
    if (env?.DEV === true) return true;
    return globalThis.localStorage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function perfMark(name: string): void {
  if (!enabled() || typeof performance === "undefined") return;
  try {
    const mark = `synelia:${name}`;
    if (mark === SUBMIT) performance.clearMarks(SUBMIT);
    performance.mark(mark);
    const start = performance.getEntriesByName(SUBMIT).at(-1);
    if (!start || mark === SUBMIT) return;
    console.info(
      `[synelia-perf] ${name} +${Math.round(performance.now() - start.startTime)} ms`,
    );
  } catch {
    // Measurement must never break a send.
  }
}
