#!/usr/bin/env bash
# Synelia fork, gate case (forced password change): with a tester added by add-tester.sh (flag set,
# NOT a test account), sign in inside the server container (no Traefik) and check that
#   get-session 200 + mustChangePassword=true, /api/me 403, a CopilotKit run 403, both with
#   code password_change_required; then change-password (revokeOtherSessions) -> /api/me 200 with
#   the new cookie, 401 with the old one. The new password is random and never stored: use only
#   on a THROWAWAY tester (e2e.sh pwchange adds and removes one). Prints statuses only.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 <email>" >&2; exit 2; }
HOST=${HOST:-konnect}
HERE=$(cd "$(dirname "$0")" && pwd)
ssh "$HOST" "bash -s -- '$1'" < <(cat "$HERE/tester-common.sh"; cat <<'REMOTE'
[ -f "$SECRET" ] || { echo "pas de secret pour ce testeur" >&2; exit 3; }
{ grep '^email=' "$SECRET"; grep '^app_password=' "$SECRET"; } | docker compose exec -T server bun -e '
const kv = Object.fromEntries((await Bun.stdin.text()).trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const base = "http://localhost:3001", origin = "https://synelia-bot.labs.synelia.tech";
const signIn = await fetch(base + "/api/auth/sign-in/email", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email: kv.email, password: kv.app_password }) });
const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const h = { cookie, origin, "content-type": "application/json" };
const session = await fetch(base + "/api/auth/get-session", { headers: h });
const flag = (await session.json().catch(() => ({})))?.user?.mustChangePassword;
const me = await fetch(base + "/api/me", { headers: h });
const meCode = (await me.json().catch(() => ({}))).code;
const run = await fetch(base + "/api/copilotkit/agent/synelia-assistant/run", { method: "POST", headers: { ...h, accept: "text/event-stream" }, body: JSON.stringify({ threadId: crypto.randomUUID(), runId: crypto.randomUUID(), state: {}, tools: [], forwardedProps: {}, context: [], messages: [{ id: crypto.randomUUID(), role: "user", content: "OK" }] }) });
const runCode = (await run.json().catch(() => ({}))).code;
// Full cycle: change the password (revokeOtherSessions), then the NEW session cookie must pass.
const newPassword = crypto.randomUUID() + "-Aa1";
const change = await fetch(base + "/api/auth/change-password", { method: "POST", headers: h, body: JSON.stringify({ currentPassword: kv.app_password, newPassword, revokeOtherSessions: true }) });
const newCookie = (change.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ");
const meAfter = await fetch(base + "/api/me", { headers: { ...h, cookie: newCookie } });
const oldAfter = await fetch(base + "/api/me", { headers: h });
const cycle = change.status === 200 && meAfter.status === 200 && oldAfter.status === 401;
console.log(`change-password ${change.status}; /api/me (new cookie) ${meAfter.status}; /api/me (old cookie) ${oldAfter.status}`);
const pass = cycle && signIn.status === 200 && session.status === 200 && flag === true && me.status === 403 && meCode === "password_change_required" && run.status === 403 && runCode === "password_change_required";
console.log(`sign-in ${signIn.status}; get-session ${session.status} mustChangePassword=${flag}; /api/me ${me.status} ${meCode}; run ${run.status} ${runCode}`);
console.log(`password-gate: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
'
REMOTE
)
