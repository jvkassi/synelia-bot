import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";

/**
 * Synelia fork: `/version.json` names the commit the running image was built from, so a deploy (and
 * a tester) can check that what is served is the announced hash.
 *
 *   server: SYNELIA_BUILD_SHA, baked into the image at build time (deploy.sh passes it as a build arg)
 *   front:  the `sha` the app build wrote into dist/version.json (also in <meta name="synelia-version">)
 *
 * Both default to "unknown"; nothing else (no env, no paths) is disclosed.
 */
export function frontBuildSha(distDir: string | undefined): string {
  if (!distDir) return "unknown";
  try {
    const parsed = JSON.parse(
      readFileSync(join(distDir, "version.json"), "utf8"),
    ) as { sha?: unknown };
    return typeof parsed.sha === "string" && parsed.sha
      ? parsed.sha
      : "unknown";
  } catch {
    return "unknown";
  }
}

export function mountVersion(
  // biome-ignore lint/suspicious/noExplicitAny: any Hono app (variables differ per caller)
  app: Hono<any>,
  distDir: string | undefined,
  env: Record<string, string | undefined> = process.env,
): void {
  const server = env.SYNELIA_BUILD_SHA?.trim() || "unknown";
  const front = frontBuildSha(distDir);
  app.get("/version.json", (context) => {
    context.header("cache-control", "no-store");
    return context.json({ server, front });
  });
}
