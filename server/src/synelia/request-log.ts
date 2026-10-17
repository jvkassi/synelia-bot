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

/**
 * No query string, and under /api/auth only the first segment after it (`/api/auth/sign-in`,
 * `/api/auth/reset-password`): Better Auth puts tokens in the path (reset-password/:token, callback
 * codes), which must never reach the log.
 */
export function loggedPath(raw: string): string {
  const path = raw.split("?")[0] ?? raw;
  if (path === "/api/auth" || path.startsWith("/api/auth/"))
    return path.split("/").slice(0, 4).join("/");
  return path;
}

export function requestLogLine(entry: {
  at: Date;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId?: string;
  /** The client went away before the response finished (closed tab, network cut, navigation). */
  aborted?: boolean;
  /** 4xx/5xx only: the body's own `code` / `error` strings (server wording, cut to 120 chars). */
  code?: string;
  error?: string;
  /** Why requireUser refused (auth/guards.ts), when it did. */
  deny?: { reason?: string; roleSource?: string };
}): string {
  const path = loggedPath(entry.path);
  const threadId = threadIdFromPath(path);
  return `${JSON.stringify({
    ts: entry.at.toISOString(),
    method: entry.method,
    path,
    status: entry.aborted ? 499 : entry.status,
    durationMs: Math.round(entry.durationMs),
    ...(entry.userId ? { userId: entry.userId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(isTestAccount(entry.userId) ? { test: true } : {}),
    ...(entry.aborted ? { aborted: true, sentStatus: entry.status } : {}),
    ...(entry.code ? { code: entry.code.slice(0, 120) } : {}),
    ...(entry.error ? { error: entry.error.slice(0, 120) } : {}),
    ...(entry.deny
      ? { denyReason: entry.deny.reason, roleSource: entry.deny.roleSource }
      : {}),
  })}\n`;
}

/** `code` / `error` of a small JSON error body, read from a clone; never anything else. */
async function errorFields(
  response: Response,
): Promise<{ code?: string; error?: string }> {
  try {
    if (!response.headers.get("content-type")?.includes("application/json"))
      return {};
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > 4096) return {};
    const body = (await response.clone().json()) as Record<string, unknown>;
    return {
      ...(typeof body.code === "string" ? { code: body.code } : {}),
      ...(typeof body.error === "string" ? { error: body.error } : {}),
    };
  } catch {
    return {};
  }
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
    // An error that escapes next() would otherwise be logged with the default 200 of an unset
    // response: it is logged as 500, then rethrown untouched.
    let thrown = false;
    try {
      await next();
    } catch (error) {
      thrown = true;
      throw error;
    } finally {
      const at = new Date();
      const vars = context.var as {
        actor?: { id?: string; email?: string };
        syneliaDeny?: { reason?: string; roleSource?: string; userId?: string };
      };
      const actor = vars.actor;
      const status = thrown ? 500 : context.res.status;
      const { code, error } =
        !thrown && status >= 400 ? await errorFields(context.res) : {};
      const line = requestLogLine({
        at,
        method: context.req.method,
        path: context.req.path,
        status,
        durationMs: performance.now() - started,
        userId: actor?.id ?? vars.syneliaDeny?.userId,
        code,
        error,
        deny: vars.syneliaDeny,
        aborted: context.req.raw.signal?.aborted === true,
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

/**
 * Per-run timing (numbers and ids only, never content), appended to the same daily file as
 * `{ kind: "run_timing", ... }`, and mirrored to stdout as `synelia_timing {...}`. The request
 * line's durationMs is useless for SSE (next() returns when the Response is created).
 */
export function logRunTiming(
  timing: Record<string, string | number | boolean | undefined>,
  dir: string | undefined = process.env.SYNELIA_REQUEST_LOG_DIR,
): string {
  const at = new Date();
  const line = JSON.stringify({
    ts: at.toISOString(),
    kind: "run_timing",
    ...Object.fromEntries(
      Object.entries(timing)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [
          key,
          typeof value === "number" ? Math.round(value) : value,
        ]),
    ),
  });
  console.log(`synelia_timing ${line}`);
  if (dir)
    void mkdir(dir, { recursive: true })
      .then(() =>
        appendFile(join(dir, `requests-${day(at)}.jsonl`), `${line}\n`),
      )
      .catch(() => {});
  return line;
}

/**
 * Synelia fork: run lifecycle lines for the deploy drain (deploy/synelia/inflight-check.sh), in the
 * same daily file as `run_timing`, ids only:
 *  - `{ kind: "synelia_run_start", threadId, runId, userId }` when the runner accepts a chat run
 *    (it will end with a `run_timing` line carrying the same runId);
 *  - `{ kind: "synelia_run_skip", reason, threadId, runId, userId }` when POST /run is answered
 *    without running anything: `already_answered` (idempotent resend) or `thread_busy` (a run is
 *    already going on the thread). Both answer 200 with a short SSE stream and write no run_timing,
 *    so without this line the drain cannot tell them from a run in flight.
 * Mirrored to stdout as `synelia_run {...}`.
 */
export function logRunEvent(
  kind: "synelia_run_start" | "synelia_run_skip",
  fields: {
    threadId: string;
    runId: string;
    userId?: string;
    reason?: "already_answered" | "thread_busy" | "retry_not_allowed";
  },
  dir: string | undefined = process.env.SYNELIA_REQUEST_LOG_DIR,
): string {
  const at = new Date();
  const line = JSON.stringify({
    ts: at.toISOString(),
    kind,
    ...(fields.reason ? { reason: fields.reason } : {}),
    threadId: fields.threadId,
    runId: fields.runId,
    ...(fields.userId ? { userId: fields.userId } : {}),
  });
  console.log(`synelia_run ${line}`);
  if (dir)
    void mkdir(dir, { recursive: true })
      .then(() =>
        appendFile(join(dir, `requests-${day(at)}.jsonl`), `${line}\n`),
      )
      .catch(() => {});
  return line;
}
