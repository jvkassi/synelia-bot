import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Synelia fork: deploy/synelia/inflight-check.sh, the drain every `server` recreate goes through
 * (deploy.sh, add-tester.sh, remove-tester.sh, set-role.sh). `ssh` is a stub that plays konnect from
 * files: $STATE/now, $STATE/started and the request log $STATE/log.<n> served on the n-th fetch (the
 * last one keeps being served), plus the read-only handle lookup. Nothing here touches konnect.
 */
const DEPLOY = join(import.meta.dir, "..", "..", "deploy", "synelia");
const LIB = join(DEPLOY, "inflight-check.sh");

const SSH_STUB = `
ssh() {
  local cmd=$2
  case "$cmd" in
    ": inflight-fetch;"*)
      n=$(( $(cat "$STATE/fetches" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE/fetches"
      f="$STATE/log.$n"; while [ ! -e "$f" ] && [ $n -gt 1 ]; do n=$((n - 1)); f="$STATE/log.$n"; done
      cat "$STATE/now" "$STATE/started"; cat "$f" 2>/dev/null; true ;;
    ": inflight-handles;"*) cat > "$STATE/sql"; cat "$STATE/handles" ;;
    *) echo "unexpected ssh: $cmd" >&2; return 99 ;;
  esac
}
`;

const S1 = "2026-10-17T18:00:00.123456789Z";
const S2 = "2026-10-17T18:10:00.5Z";
const runLine = (ts: string, user: string) =>
  JSON.stringify({ ts, method: "POST", path: "/api/copilotkit/agent/synelia-assistant/run", status: 200, durationMs: 40, userId: user });
const threadLine = (ts: string, user: string, threadId: string) =>
  JSON.stringify({ ts, method: "GET", path: `/api/threads/${threadId}`, status: 200, durationMs: 3, userId: user, threadId });
const timingLine = (ts: string, user: string, threadId: string, runId: string) =>
  JSON.stringify({ ts, kind: "run_timing", threadId, runId, userId: user, outcome: "done" });

const OPENED = [
  threadLine("2026-10-17T18:05:00.000Z", "aliceUserId0001", "thread-A"),
  runLine("2026-10-17T18:05:00.100Z", "aliceUserId0001"),
].join("\n");
const FINISHED = `${OPENED}\n${timingLine("2026-10-17T18:05:30.000Z", "aliceUserId0001", "thread-A", "run-A")}`;

async function run(script: string, state: Record<string, string>, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inflight-"));
  for (const [k, v] of Object.entries(state)) writeFileSync(join(dir, k), v.endsWith("\n") ? v : `${v}\n`);
  const proc = Bun.spawn(
    ["bash", "-c", `set -euo pipefail\n${SSH_STUB}\n. "${LIB}"\n${script}`],
    { env: { ...process.env, STATE: dir, INFLIGHT_POLL: "0.2", HOST: "stub", ...env }, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code, dir, fetches: (() => { try { return Number(readFileSync(join(dir, "fetches"), "utf8").trim()); } catch { return 0; } })() };
}

/** What deploy.sh / the tester scripts do around a recreate; the "recreate" moves $STATE/started. */
const RECREATE = `
if inflight_gate 2; then
  old=$INFLIGHT_LAST_STARTED
  echo "RECREATE"; echo "${S2}" > "$STATE/started"; [ ! -e "$STATE/race" ] || cp "$STATE/race" "$STATE/log.$(( $(cat "$STATE/fetches") + 1 ))"
  inflight_cut_report "$old"
else
  echo "ABORTED rc=$?"
fi
`;

test("idle: the gate passes on the first check and the recreate cuts nothing", async () => {
  const r = await run(RECREATE, { now: "2026-10-17T18:06:00Z", started: S1, "log.1": FINISHED, handles: "aliceUserId0001 alice" });
  expect(r.code).toBe(0);
  expect(r.out).toContain("inflight: 0 run(s) en cours");
  expect(r.out).toContain("RECREATE");
  expect(r.out).toContain("runs coupés par la recréation");
  expect(r.out).toContain(": 0");
  expect(r.out).not.toContain("RUN COUPÉ start");
  expect(r.fetches).toBe(2);
});

test("in flight, then finishes within the wait: the gate waits, then proceeds", async () => {
  const r = await run(RECREATE, { now: "2026-10-17T18:05:40Z", started: S1, "log.1": OPENED, "log.2": OPENED, "log.3": FINISHED, handles: "aliceUserId0001 alice" });
  expect(r.code).toBe(0);
  expect(r.out).toContain("inflight: attente, 1 run(s) en cours");
  expect(r.out).toContain("RECREATE");
  expect(r.out).not.toContain("ABORTED");
  expect(r.out).not.toContain("RUN COUPÉ start");
});

test("in flight past the timeout: abort, non-zero, and the run that would be cut is listed", async () => {
  const r = await run(RECREATE, { now: "2026-10-17T18:05:10Z", started: S1, "log.1": OPENED, handles: "aliceUserId0001 alice" });
  expect(r.out).toContain("ABORTED rc=3");
  expect(r.out).not.toContain("RECREATE");
  expect(r.out).toContain("EN COURS start=2026-10-17T18:05:00.100Z user=alice thread=thread-A");
  expect(r.err).toContain("SERONT COUPÉS");
  expect(r.err).toContain("ABANDON");
  // The lookup is one read-only SELECT on the ids seen, nothing else.
  expect(readFileSync(join(r.dir, "sql"), "utf8")).toBe("SELECT id || ' ' || split_part(email, '@', 1) FROM users WHERE id IN ('aliceUserId0001');\n");
});

test("in flight past the timeout with --force-cut: recreate, and the cut run is reported post hoc", async () => {
  const r = await run(RECREATE, { now: "2026-10-17T18:10:30Z", started: S1, "log.1": OPENED, handles: "aliceUserId0001 alice" }, { FORCE_CUT: "1" });
  expect(r.out).toContain("RECREATE");
  expect(r.err).toContain("--force-cut");
  expect(r.out).toContain("RUN COUPÉ start=2026-10-17T18:05:00.100Z user=alice thread=thread-A");
});

test("a run arriving between the last check and the recreate is reported post hoc as cut", async () => {
  const race = `${FINISHED}\n${threadLine("2026-10-17T18:09:59.000Z", "bobUserId000002", "thread-B")}\n${runLine("2026-10-17T18:09:59.900Z", "bobUserId000002")}`;
  const r = await run(RECREATE, { now: "2026-10-17T18:10:30Z", started: S1, "log.1": FINISHED, race, handles: "bobUserId000002 bob" });
  expect(r.code).toBe(0);
  expect(r.out).toContain("RECREATE");
  expect(r.out).toContain("RUN COUPÉ start=2026-10-17T18:09:59.900Z user=bob thread=thread-B");
  expect(r.out).toContain(": 1");
});

test("unknown user handle: the id is shortened, never a lookup failure", async () => {
  const r = await run(`inflight_check || true`, { now: "2026-10-17T18:05:10Z", started: S1, "log.1": OPENED, handles: "" });
  expect(r.out).toContain("user=id:aliceUse…");
});

test("cannot tell (konnect unreachable): the gate fails closed unless --force-cut", async () => {
  const stubFail = `ssh() { return 255; }`;
  const closed = await run(`${stubFail}\nif inflight_gate 1; then echo PASSED; else echo "ABORTED rc=$?"; fi`, { now: "x", started: "x" });
  expect(closed.out).toContain("ABORTED rc=2");
  const forced = await run(`${stubFail}\nif inflight_gate 1; then echo PASSED; else echo "ABORTED rc=$?"; fi`, { now: "x", started: "x" }, { FORCE_CUT: "1" });
  expect(forced.out).toContain("PASSED");
});

test("a POST /run of the previous process is not in flight (it died with it)", async () => {
  const r = await run(`if inflight_check; then echo IDLE; fi`, { now: "2026-10-17T18:12:00Z", started: S2, "log.1": OPENED, handles: "aliceUserId0001 alice" });
  expect(r.out).toContain("perdu au redémarrage");
  expect(r.out).toContain("IDLE");
});

test("every server recreate goes through the gate, and deploy.sh recreates right after it", () => {
  const deploy = readFileSync(join(DEPLOY, "deploy.sh"), "utf8");
  const gate = deploy.indexOf("if ! inflight_gate 120; then");
  const up = deploy.indexOf("docker compose up -d >>");
  expect(gate).toBeGreaterThan(0);
  expect(up).toBeGreaterThan(gate);
  // Only bookkeeping between the gate's success and the recreate: no ssh, no sleep.
  const between = deploy.slice(deploy.indexOf("old_start=$INFLIGHT_LAST_STARTED"), up);
  expect(between).not.toMatch(/sleep|docker compose run|rsync/);
  expect(deploy.indexOf("inflight_cut_report")).toBeGreaterThan(up);
  for (const name of ["add-tester.sh", "remove-tester.sh", "set-role.sh"]) {
    const script = readFileSync(join(DEPLOY, name), "utf8");
    const g = script.indexOf("inflight_gate 120 || exit $?");
    expect(g).toBeGreaterThan(0);
    expect(script.indexOf('ssh "$HOST"', g)).toBeGreaterThan(g);
    expect(script.indexOf("inflight_cut_report")).toBeGreaterThan(script.indexOf("REMOTE\n)"));
  }
});
