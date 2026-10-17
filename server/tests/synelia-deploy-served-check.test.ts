import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Synelia fork: deploy/synelia/served-check.sh (sourced by deploy.sh). `ssh` is a stub that plays
 * konnect's docker state from files; the public URL is a local basic-auth server whose password
 * contains " and \ (curl config escaping). Nothing here touches konnect.
 */
const LIB = join(
  import.meta.dir,
  "..",
  "..",
  "deploy",
  "synelia",
  "served-check.sh",
);
const USER = 'te"st\\er';
const PASS = 'p\\"a ss\\\\w"d';
const NEW = "1111111111111111111111111111111111111111";
const OLD = "2222222222222222222222222222222222222222";
let publicSha = NEW;
let server: ReturnType<typeof Bun.serve>;
let envFile: string;

beforeAll(() => {
  const good = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      if (request.headers.get("authorization") !== good)
        return new Response("no", {
          status: 401,
          headers: { "www-authenticate": 'Basic realm="x"' },
        });
      const path = new URL(request.url).pathname;
      if (path === "/version.json")
        return Response.json({ server: publicSha, front: publicSha });
      return new Response(
        `<html><head><meta name="synelia-version" content="${publicSha}" /></head></html>`,
        {
          headers: { "content-type": "text/html" },
        },
      );
    },
  });
  const dir = mkdtempSync(join(tmpdir(), "served-check-"));
  envFile = join(dir, "e2e.env");
  writeFileSync(
    envFile,
    `E2E_URL=http://127.0.0.1:${server.port}\nE2E_BASIC_USER=${USER}\nE2E_BASIC_PASSWORD=${PASS}\n`,
    { mode: 0o600 },
  );
});
afterAll(() => server.stop(true));

/** konnect's docker, from files in $STATE: phase0/previous image ids, running id, version bodies. */
const SSH_STUB = `
ssh() {
  local cmd=$2
  case "$cmd" in
    *"docker compose exec -T server bun"*) cat "$STATE/served" ;;
    *'docker inspect $(docker compose ps -q server)'*) cat "$STATE/running" ;;
    *"image inspect synelia-bot-server:phase0 --format"*) cat "$STATE/phase0" ;;
    *"image inspect synelia-bot-server:previous --format"*) cat "$STATE/previous" ;;
    *"image inspect synelia-bot-server:previous >/dev/null"*) [ -s "$STATE/previous" ] && [ -s "$STATE/mastra-previous" ] ;;
    *"docker image tag synelia-bot-server:previous synelia-bot-server:phase0 && docker image tag synelia-bot-mastra:previous synelia-bot-mastra:phase0"*)
      cp "$STATE/previous" "$STATE/phase0"; cp "$STATE/previous" "$STATE/running"
      cp "$STATE/previous-served" "$STATE/served"; echo "$PREV" > "$STATE/deployed"; echo "retag server+mastra" >> "$STATE/log" ;;
    *"cat $DIR/src/DEPLOYED_COMMIT"*) cat "$STATE/deployed" ;;
    *) echo "unexpected ssh: $cmd" >&2; return 99 ;;
  esac
}
`;

async function run(script: string, state: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  for (const [k, v] of Object.entries(state)) writeFileSync(join(dir, k), v);
  const proc = Bun.spawn(
    [
      "bash",
      "-c",
      `set -uo pipefail; HOST=konnect; DIR=/srv/synelia-bot; SERVED_RETRY_SLEEP=0; . "${LIB}"; ${SSH_STUB}\n${script}`,
    ],
    {
      env: { ...process.env, STATE: dir, PREV: OLD, ENVF: envFile },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { out: out + err, code };
}

const json = (sha: string) => JSON.stringify({ server: sha, front: sha });

test('curl config quoting: a basic password with " and \\ authenticates, and is never printed', async () => {
  publicSha = NEW;
  const { out, code } = await run(`public_get "$ENVF" /version.json`, {});
  expect(code).toBe(0);
  expect(out).toContain(NEW);
  const quoted = await run(`curl_cfg_quote 'a"b\\c'`, {});
  expect(quoted.out).toBe('"a\\"b\\\\c"');
});

test("check_served: recreated container, server+front+Traefik+meta = commit → 0, no secret in output", async () => {
  publicSha = NEW;
  const { out, code } = await run(`check_served ${NEW} "$ENVF"`, {
    running: "sha256:new",
    phase0: "sha256:new",
    served: json(NEW),
  });
  expect(code).toBe(0);
  expect(out).toContain("recréé");
  expect(out).not.toContain(PASS);
  expect(out).not.toContain(USER);
});

test("check_served fails when the container was not recreated, or any SHA differs", async () => {
  publicSha = NEW;
  expect(
    (
      await run(`check_served ${NEW} "$ENVF"`, {
        running: "sha256:old",
        phase0: "sha256:new",
        served: json(NEW),
      })
    ).code,
  ).not.toBe(0);
  expect(
    (
      await run(`check_served ${NEW} "$ENVF"`, {
        running: "sha256:new",
        phase0: "sha256:new",
        served: json(OLD),
      })
    ).code,
  ).not.toBe(0);
  publicSha = OLD; // Traefik / cache serving something else
  expect(
    (
      await run(`check_served ${NEW} "$ENVF"`, {
        running: "sha256:new",
        phase0: "sha256:new",
        served: json(NEW),
      })
    ).code,
  ).not.toBe(0);
});

test("mismatch → rollback retags :previous, and is verified by the previous /version.json", async () => {
  const { out, code } = await run(
    `rollback_previous_image ${OLD} "$ENVF"; echo "rc=$?"; cat "$STATE/log"`,
    {
      running: "sha256:new",
      phase0: "sha256:new",
      previous: "sha256:old",
      "mastra-previous": "sha256:mold",
      served: json(NEW),
      "previous-served": json(OLD),
      deployed: NEW,
    },
  );
  expect(code).toBe(0);
  expect(out).toContain("retag server+mastra");
  expect(out).toContain(`rollback vérifié : ${OLD}`);
  expect(out).toContain("rc=0");
});

test("rollback to an image older than /version.json: verified by container on :previous + DEPLOYED_COMMIT", async () => {
  const { out } = await run(
    `rollback_previous_image ${OLD} "$ENVF"; echo "rc=$?"`,
    {
      running: "sha256:new",
      phase0: "sha256:new",
      previous: "sha256:old",
      "mastra-previous": "sha256:mold",
      served: json(NEW),
      "previous-served": "<!doctype html><html></html>",
      deployed: NEW,
    },
  );
  expect(out).toContain("pas de /version.json");
  expect(out).toContain("rc=0");
});

test("no :previous image → rollback refuses loudly (rc 2)", async () => {
  const { out } = await run(
    `rollback_previous_image ${OLD} "$ENVF"; echo "rc=$?"`,
    { previous: "" },
  );
  expect(out).toContain("ROLLBACK IMPOSSIBLE");
  expect(out).toContain("rc=2");
});

test("server and agent-mastra roll back together: no mastra :previous → refused (rc 2)", async () => {
  const { out } = await run(
    `rollback_previous_image ${OLD} "$ENVF"; echo "rc=$?"`,
    {
      previous: "sha256:old",
      "mastra-previous": "",
    },
  );
  expect(out).toContain("ROLLBACK IMPOSSIBLE");
  expect(out).toContain("rc=2");
});

test("migrations_changed: drizzle/ untouched → 0; drizzle/ changed or previous commit unknown → 1 (no automatic rollback)", async () => {
  const repo = join(import.meta.dir, "..", "..");
  const rc = async (a: string, b: string) =>
    (
      await run(`cd "${repo}"; migrations_changed ${a} ${b}; echo "rc=$?"`, {})
    ).out.trim();
  expect(await rc("2ad297d5", "HEAD")).toBe("rc=0");
  expect(await rc("e093b517~1", "e093b517")).toBe("rc=1");
  expect(await rc("0000000000000000000000000000000000000000", "HEAD")).toBe(
    "rc=1",
  );
  expect(await rc('""', "HEAD")).toBe("rc=1");
});
