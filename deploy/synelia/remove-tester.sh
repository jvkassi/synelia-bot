#!/usr/bin/env bash
# Synelia fork: remove-tester.sh <email> — undo add-tester.sh: env entries (after backup), the
# basicauth entry, the app account (DELETE FROM users, cascades sessions/accounts) and the secrets
# file; also drops the email from INITIAL_ADMIN_EMAILS (an admin added with --role admin), so a
# later account with that address is not promoted at sign-in; recreates only the synelia server and
# checks the other stacks did not move.
set -euo pipefail
# --force-cut (first argument) or FORCE_CUT=1: recreate even if chat runs are still in flight after the
# 120 s wait (see inflight-check.sh).
if [ "${1:-}" = --force-cut ]; then FORCE_CUT=1; shift; fi
echo "AVERTISSEMENT : ce script recrée le conteneur server synelia (coupure de quelques secondes pour tous). Fenêtre annoncée uniquement. L'email est aussi retiré de INITIAL_ADMIN_EMAILS."
[ $# -eq 1 ] || { echo "usage: $0 <email>" >&2; exit 2; }
HOST=${HOST:-konnect}
HERE=$(cd "$(dirname "$0")" && pwd)
# Synelia fork: no chat run in flight before the recreate (bounded wait, abort unless --force-cut /
# FORCE_CUT=1), then the runs the recreate cut, for the announcement. See inflight-check.sh.
# shellcheck source=inflight-check.sh
. "$(cd "$(dirname "$0")" && pwd)/inflight-check.sh"
inflight_gate 120 || exit $?
INFLIGHT_OLD_START=$INFLIGHT_LAST_STARTED
set +e
ssh "$HOST" "bash -s -- '$1'" < <(cat "$HERE/tester-common.sh"; cat <<'REMOTE'
backup
sed -i "/^SYNELIA_TESTER_${SLUG}_\(EMAIL\|PASSWORD\)=/d" .env.server
NAME="$NAME" python3 - <<'PY'
import os
p='.env'; lines=open(p).read().split('\n')
for i,l in enumerate(lines):
    if l.startswith('BASICAUTH_USERS='):
        v=l.split('=',1)[1]; q=v[0] if v[:1] in "'\"" else ''
        inner=v[1:-1] if q else v
        kept=[e for e in inner.split(',') if e.split(':',1)[0]!=os.environ['NAME']]
        lines[i]='BASICAUTH_USERS='+q+','.join(kept)+q
open(p,'w').write('\n'.join(lines))
PY
EMAIL="$EMAIL" python3 - <<'PY'
import os
p='.env.server'; lines=open(p).read().split('\n'); e=os.environ['EMAIL']
for i,l in enumerate(lines):
    if l.startswith('INITIAL_ADMIN_EMAILS='):
        v=l.split('=',1)[1].strip().strip('"\'')
        lines[i]='INITIAL_ADMIN_EMAILS='+','.join(x.strip() for x in v.split(',') if x.strip() and x.strip().lower()!=e)
open(p,'w').write('\n'.join(lines))
PY
if grep '^INITIAL_ADMIN_EMAILS=' .env.server | cut -d= -f2- | tr -d '"'"'"'"' | tr ',' '\n' | tr 'A-Z' 'a-z' | sed 's/^ *//;s/ *$//' | grep -qxF "$EMAIL"; then echo "toujours dans INITIAL_ADMIN_EMAILS" >&2; exit 7; fi
echo "absent de INITIAL_ADMIN_EMAILS"
chmod 600 .env .env.server
n=$(printf "WITH d AS (DELETE FROM users WHERE email = :'email' RETURNING 1) SELECT count(*) FROM d;\n" | psql_q | tr -d '[:space:]')
echo "comptes supprimés: $n"
rm -f "$SECRET"
recreate_server
echo "testeur retiré"
REMOTE
)
remote_rc=$?
set -e
inflight_cut_report "$INFLIGHT_OLD_START"
exit $remote_rc
