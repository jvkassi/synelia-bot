#!/usr/bin/env bash
# Synelia fork: chat runs in flight on konnect, read-only (request log + container start time).
#
# Two sources, the precise one preferred:
#  - pass10 server and later: `synelia_run_start` (runner accepted a chat run: threadId, runId,
#    userId) closed by the `run_timing` of the same runId; `synelia_run_skip` (already_answered,
#    thread_busy) is a POST answered without a run. In flight = a start with no run_timing, exactly.
#  - fallback, 264ca566 (served today): only `POST /api/copilotkit/agent/<id>/run` (200, written when
#    the SSE response starts; NO thread id, NO run id; thread_busy and the idempotent resend also
#    answer 200, never 409) and `run_timing` (written when the stream ends). A POST is matched to a
#    timing by (user, thread), the thread being the last one that user read before the POST, or a
#    thread that did not exist yet when the POST was sent (the POST created it). A POST
#    followed by a completed run on its thread is excluded (thread_busy). Residual fallback risks:
#    an idempotent resend is not observable (it reads as in flight until INFLIGHT_MAX_AGE unless a
#    later run completes on its thread); a run sent with no thread read before it (API client, e2e)
#    has thread "?" and only takes a timing no known-thread POST of that user claims; two NEW threads
#    started by one person at the same time are told apart only by order; two tabs of the same person
#    on two existing threads can mis-attribute the thread.
# A run older than the current server's start died with the previous process ("perdu au
# redémarrage"). Headless runs (routines, handoffs) have no POST /run here; deploy.sh keeps its
# synelia_thread_lock wait for those.
#
# Standalone:
#   inflight-check.sh                 one check: exit 0 idle, 3 in flight, 2 cannot tell
#   inflight-check.sh --wait SECS     poll every INFLIGHT_POLL (10 s) up to SECS: 0 idle, 3 still in flight
#   inflight-check.sh --cut-since TS  after a recreate: runs cut by it (POST /run since TS, before the
#                                     new server start, never completed); always exit 0
#   --at TS --started TS              replay the log as of TS with that server start (validation only)
# Sourced (deploy.sh, add/remove-tester.sh, set-role.sh): inflight_drain, inflight_server_started,
# inflight_gate, inflight_cut_report. FORCE_CUT=1 = --force-cut. Read-only on konnect: date, docker inspect, cat of the request log, one
# read-only SELECT (user handles). Nothing is written on konnect; no secret is read or printed.
INFLIGHT_DIR=${INFLIGHT_DIR:-/srv/synelia-bot}
INFLIGHT_MAX_AGE=${INFLIGHT_MAX_AGE:-900}
INFLIGHT_POLL=${INFLIGHT_POLL:-10}
INFLIGHT_AT=${INFLIGHT_AT:-}
INFLIGHT_STARTED=${INFLIGHT_STARTED:-}

# stdout: line 1 = now (UTC), line 2 = server container StartedAt, then yesterday's + today's log.
inflight_fetch() {
  ssh "${HOST:-konnect}" ": inflight-fetch; cd $INFLIGHT_DIR && date -u +%Y-%m-%dT%H:%M:%SZ && docker inspect -f '{{.State.StartedAt}}' \$(docker compose ps -q server) && { cat logs/requests-\$(date -u -d yesterday +%F).jsonl logs/requests-\$(date -u +%F).jsonl 2>/dev/null; true; }"
}

inflight_server_started() { { inflight_fetch || true; } | sed -n 2p; }

INFLIGHT_PY='
import json, re, sys
from datetime import datetime, timedelta
def ts(s):
    s = (s or "").strip().rstrip("Z")
    if "." in s:
        head, frac = s.split(".", 1)
        return datetime.strptime(head + "." + (frac + "000000")[:6], "%Y-%m-%dT%H:%M:%S.%f")
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S")
mode, max_age, at, started_override = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4]
since = sys.argv[5] if len(sys.argv) > 5 else ""
lines = sys.stdin.read().split("\n")
print("#mark started=" + (started_override or (lines[1] if len(lines) > 1 else "")).strip())
try:
    now = ts(at or lines[0]); started = ts(started_override or lines[1])
except Exception:
    print("inflight: heure ou démarrage du server illisibles", file=sys.stderr); sys.exit(2)
rows = []
for raw in lines[2:]:
    try: d = json.loads(raw)
    except Exception: continue
    if not isinstance(d, dict) or "ts" not in d: continue
    try: d["_t"] = ts(d["ts"])
    except Exception: continue
    if d["_t"] <= now: rows.append(d)
rows.sort(key=lambda d: d["_t"])
kind = lambda d: d.get("kind") or d.get("type") or ""
THREAD = re.compile(r"/threads/([^/?]+)")
def is_post_run(d):
    p = d.get("path", "")
    return d.get("method") == "POST" and p.startswith("/api/copilotkit/agent/") and p.endswith("/run") and d.get("status") == 200
# 1) Precise lines (pass10 server and later): synelia_run_start / synelia_run_skip / run_timing, by runId.
timed = set(d.get("runId") for d in rows if kind(d) == "run_timing" and d.get("runId"))
starts = [d for d in rows if kind(d) == "synelia_run_start" and d.get("runId")]
precise = [d for d in rows if kind(d) in ("synelia_run_start", "synelia_run_skip")]
open_runs = [dict(d, _thread=d.get("threadId", "?"), _how="précis") for d in starts if d["runId"] not in timed]
# 2) Fallback (264ca566: no such lines). A POST /run is covered when a precise line of the same user
# was written just before it (the runner logs before the response starts); covered POSTs are done.
used = set()
fallback = []
for d in rows:
    if not is_post_run(d): continue
    cover = None
    for i, q in enumerate(precise):
        if i in used or q.get("userId") != d.get("userId"): continue
        if timedelta(0) <= d["_t"] - q["_t"] <= timedelta(seconds=10): cover = i; break
    if cover is not None: used.add(cover); continue
    fallback.append(d)
# The POST line carries no thread id in 264ca566: the thread is the last one this user read before
# it (GET /api/threads/<id>, …/threads/<id>/messages, /api/synelia/threads/<id>/models), else "?".
last_seen = {}
fb = set(id(d) for d in fallback)
for d in rows:
    m = THREAD.search(d.get("path", "")) if d.get("method") == "GET" else None
    if m and d.get("userId"): last_seen[d["userId"]] = d.get("threadId") or m.group(1)
    if id(d) in fb: d["_thread"] = last_seen.get(d.get("userId"), "?")
# Match each run_timing not explained by a precise start to a fallback POST of the SAME user, by
# thread, in this order: POST whose inferred thread is the timing thread (latest first); POST of
# unknown thread; POST sent before the timing thread ever appeared in the log (the POST created that
# thread, so the inferred thread was only the page read before). Never a POST inferred on another
# thread that already existed: two runs of one person on two known threads do not cancel each other.
first_seen = {}
for d in rows:
    m = THREAD.search(d.get("path", ""))
    for t in (d.get("threadId"), m.group(1) if m else None):
        if t: first_seen.setdefault(t, d["_t"])
pending = list(fallback)
start_ids = set(d["runId"] for d in starts)
last_done = {}
for t in rows:
    if kind(t) != "run_timing": continue
    last_done.setdefault(t.get("threadId"), []).append(t["_t"])
    if t.get("runId") in start_ids or not t.get("userId"): continue
    cands = [r for r in pending if r.get("userId") == t["userId"] and r["_t"] <= t["_t"]]
    born = first_seen.get(t.get("threadId"), t["_t"])
    for tier in (lambda r: r["_thread"] == t.get("threadId"), lambda r: r["_thread"] == "?", lambda r: r["_t"] <= born):
        same = [r for r in cands if tier(r)]
        if same: pending.remove(same[-1]); break
# thread_busy without the precise line: two runs never overlap on one thread, so an open POST on
# thread T followed by a completed run on T is not running (it was refused, or its timing was taken
# by the other POST of that thread).
for r in pending:
    later = [x for x in last_done.get(r["_thread"], []) if x > r["_t"]] if r["_thread"] != "?" else []
    if not later: open_runs.append(dict(r, _how="repli"))
open_runs = [r for r in open_runs if now - r["_t"] <= timedelta(seconds=max_age)]
open_runs.sort(key=lambda r: r["_t"])
def fmt(r):
    if r["_how"] == "précis":
        return "start=%s user=@%s thread=%s run=%s" % (r["ts"], r.get("userId", "?"), r.get("_thread", "?"), r.get("runId"))
    return "start=%s user=@%s thread=%s run=inconnu [repli 264ca566 : thread déduit]" % (r["ts"], r.get("userId", "?"), r.get("_thread", "?"))
if mode == "check":
    live = [r for r in open_runs if r["_t"] >= started]
    for r in open_runs:
        if r["_t"] < started: print("perdu au redémarrage (déjà coupé, info) " + fmt(r))
    for r in live: print("EN COURS " + fmt(r))
    print("inflight: %d run(s) en cours au %sZ (server démarré %sZ)" % (len(live), now.isoformat(timespec="seconds"), started.isoformat(timespec="seconds")))
    sys.exit(3 if live else 0)
if mode == "cut":
    t0 = ts(since)
    cut = [r for r in open_runs if t0 <= r["_t"] < started]
    for r in cut: print("RUN COUPÉ " + fmt(r) + " (jamais terminé)")
    print("runs coupés par la recréation (runs démarrés entre %sZ et le démarrage %sZ) : %d" % (t0.isoformat(timespec="seconds"), started.isoformat(timespec="seconds"), len(cut)))
    sys.exit(0)
sys.exit(2)
'

# Replaces user=@<id> by the user handle (email local part); the id stays if the lookup fails.
inflight_handles() {
  local text ids sql map
  text=$(cat)
  ids=$(printf '%s\n' "$text" | grep -o 'user=@[A-Za-z0-9_-]*' | cut -c7- | sort -u | grep -v '^$' || true)
  if [ -n "$ids" ]; then
    sql="SELECT id || ' ' || split_part(email, '@', 1) FROM users WHERE id IN ($(printf "'%s'," $ids | sed 's/,$//'));"
    map=$(printf '%s\n' "$sql" | ssh "${HOST:-konnect}" ": inflight-handles; cd $INFLIGHT_DIR && docker compose exec -T postgres sh -c 'PGOPTIONS=\"-c default_transaction_read_only=on\" psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tA'" 2>/dev/null || true)
    while read -r id handle; do
      [ -n "${id:-}" ] && [ -n "${handle:-}" ] || continue
      case "$id$handle" in *[!A-Za-z0-9._+-]*) continue ;; esac
      text=$(printf '%s\n' "$text" | sed "s/user=@$id/user=$handle/g")
    done <<< "$map"
  fi
  printf '%s\n' "$text" | sed -E 's/user=@([A-Za-z0-9_-]{8})[A-Za-z0-9_-]*/user=id:\1…/g'
}

# One check. stdout: report (first line "#mark started=<server StartedAt>", for the callers).
# Return 0 idle, 3 in flight, 2 cannot tell (fail closed). Safe under set -euo pipefail.
inflight_check() {
  local data out rc=0
  data=$(inflight_fetch) || { echo "inflight: konnect injoignable ou server absent" >&2; return 2; }
  out=$(printf '%s\n' "$data" | python3 -c "$INFLIGHT_PY" check "$INFLIGHT_MAX_AGE" "$INFLIGHT_AT" "$INFLIGHT_STARTED") || rc=$?
  printf '%s\n' "$out" | inflight_handles
  return $rc
}

# Bounded wait (poll every INFLIGHT_POLL s, max $1 s, default 120). Return 0 idle, 3 still in flight
# (the runs that WILL be cut are listed), 2 cannot tell. Sets INFLIGHT_LAST_STARTED (server start
# seen by the last check), the reference for inflight_cut_report.
INFLIGHT_LAST_STARTED=""
inflight_drain() {
  local max=${1:-120} start=$SECONDS out rc
  while :; do
    rc=0; out=$(inflight_check) || rc=$?
    INFLIGHT_LAST_STARTED=$(printf '%s\n' "$out" | sed -n 's/^#mark started=//p' | head -1)
    out=$(printf '%s\n' "$out" | grep -v '^#mark' || true)
    if [ $rc = 0 ]; then printf '%s\n' "$out" | tail -1; return 0; fi
    if [ $rc != 3 ]; then printf '%s\n' "$out"; return $rc; fi
    if [ $((SECONDS - start)) -ge "$max" ]; then
      printf '%s\n' "$out"
      echo "inflight: délai de ${max} s dépassé ; ces runs SERONT COUPÉS par la recréation du server (lignes EN COURS ci-dessus)." >&2
      return 3
    fi
    echo "inflight: attente, $(printf '%s\n' "$out" | grep -c '^EN COURS' || true) run(s) en cours…"
    sleep "$INFLIGHT_POLL"
  done
}

# The gate every `server` recreate goes through (deploy.sh, add/remove-tester.sh, set-role.sh).
# Return 0 = recreate now (no pause after this), non-zero = abort. FORCE_CUT=1 (--force-cut) recreates
# anyway after the bounded wait, the runs listed above being cut.
inflight_gate() {
  local rc=0
  inflight_drain "${1:-120}" || rc=$?
  [ $rc = 0 ] && return 0
  if [ "${FORCE_CUT:-0}" = 1 ]; then
    echo "--force-cut : recréation du server malgré l'état ci-dessus (runs listés coupés, à annoncer)." >&2
    return 0
  fi
  if [ $rc = 3 ]; then
    echo "ABANDON : des runs de chat sont en cours, le server n'est PAS recréé. Attendez, ou annoncez la coupure puis relancez avec --force-cut." >&2
  else
    echo "ABANDON : impossible de vérifier les runs en cours, le server n'est PAS recréé (--force-cut pour passer outre)." >&2
  fi
  return $rc
}

# After a recreate: runs cut by it. $1 = server StartedAt read just before the recreate (or the last
# check time). Prints "RUN COUPÉ …" lines for the announcement in the channel. Never fails the caller.
inflight_cut_report() {
  local since=$1 data
  [ -n "$since" ] || { echo "inflight: pas de repère avant recréation, rapport des runs coupés impossible" >&2; return 0; }
  data=$(inflight_fetch) || { echo "inflight: rapport post-recréation impossible (konnect)" >&2; return 0; }
  if [ "$(printf '%s\n' "$data" | sed -n 2p)" = "$since" ]; then echo "inflight: le server n'a pas été recréé, aucun run coupé"; return 0; fi
  printf '%s\n' "$data" | python3 -c "$INFLIGHT_PY" cut "$INFLIGHT_MAX_AGE" "$INFLIGHT_AT" "$INFLIGHT_STARTED" "$since" | grep -v '^#mark' | inflight_handles || true
  return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u
  MODE=check; ARG=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --wait) MODE=wait; ARG=${2:?--wait SECS}; shift 2 ;;
      --cut-since) MODE=cut; ARG=${2:?--cut-since TS}; shift 2 ;;
      --at) INFLIGHT_AT=${2:?}; shift 2 ;;
      --started) INFLIGHT_STARTED=${2:?}; shift 2 ;;
      -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
      *) echo "option inconnue: $1" >&2; exit 2 ;;
    esac
  done
  case $MODE in
    check) rc=0; out=$(inflight_check) || rc=$?; printf '%s\n' "$out" | grep -v '^#mark'; exit $rc ;;
    wait) inflight_drain "$ARG"; exit $? ;;
    cut) inflight_cut_report "$ARG"; exit 0 ;;
  esac
fi
