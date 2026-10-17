/**
 * Synelia fork: structured per-request log, one JSON object per line, in daily files
 * `requests-YYYY-MM-DD.jsonl` under SYNELIA_REQUEST_LOG_DIR (unset = off), keeping 7 days.
 *
 * Written: ts, method, path (NO query string), status, durationMs, userId, threadId (from the path
 * when it carries one), test (true for SYNELIA_TEST_ACCOUNTS users). Never bodies, headers,
 * cookies or tokens.
 */
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { isTestAccount } from "./test-accounts";

const KEEP_DAYS = 7;
const THREAD_IN_PATH = [
  /^\/api\/threads\/([^/]+)/,
  /^\/api\/copilotkit\/agent\/[^/]+\/stop\/([^/]+)/,
  /^\/api\/copilotkit\/threads\/([^/]+)/,
];

export function threadIdFromPath(path: string): string | undefined {
  for (const pattern of THREAD_IN_PATH) {
    const match = pattern.exec(path);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

export function requestLogLine(entry: {
  at: Date;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId?: string;
  userEmail?: string;
}): string {
  const path = entry.path.split("?")[0] ?? entry.path;
  const threadId = threadIdFromPath(path);
  return `${JSON.stringify({
    ts: entry.at.toISOString(),
    method: entry.method,
    path,
    status: entry.status,
    durationMs: Math.round(entry.durationMs),
    ...(entry.userId ? { userId: entry.userId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(isTestAccount(entry.userEmail) ? { test: true } : {}),
  })}\n`;
}

const day = (at: Date) => at.toISOString().slice(0, 10);

async function prune(dir: string, now: Date) {
  const cutoff = day(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const match = /^requests-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
    if (match?.[1] && match[1] <= cutoff)
      await unlink(join(dir, name)).catch(() => {});
  }
}

export function createRequestLog(
  dir: string | undefined = process.env.SYNELIA_REQUEST_LOG_DIR,
): MiddlewareHandler {
  if (!dir) return async (_context, next) => next();
  let ready: Promise<unknown> | undefined;
  let lastDay = "";
  return async (context, next) => {
    const started = performance.now();
    try {
      await next();
    } finally {
      const at = new Date();
      const actor = (context.var as { actor?: { id?: string; email?: string } })
        .actor;
      const line = requestLogLine({
        at,
        method: context.req.method,
        path: context.req.path,
        status: context.res.status,
        durationMs: performance.now() - started,
        userId: actor?.id,
        userEmail: actor?.email,
      });
      ready ??= mkdir(dir, { recursive: true });
      const today = day(at);
      void ready
        .then(async () => {
          if (today !== lastDay) {
            lastDay = today;
            await prune(dir, at);
          }
          await appendFile(join(dir, `requests-${today}.jsonl`), line);
        })
        .catch(() => {});
    }
  };
}
