#!/usr/bin/env bash
# Synelia fork: remove-tester.sh <email> — undo add-tester.sh: env entries (after backup), the
# basicauth entry, the app account (DELETE FROM users, cascades sessions/accounts) and the secrets
# file; recreates only the synelia server and checks the other stacks did not move.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 <email>" >&2; exit 2; }
HOST=${HOST:-konnect}
HERE=$(cd "$(dirname "$0")" && pwd)
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
chmod 600 .env .env.server
n=$(printf "WITH d AS (DELETE FROM users WHERE email = :'email' RETURNING 1) SELECT count(*) FROM d;\n" | psql_q | tr -d '[:space:]')
echo "comptes supprimés: $n"
rm -f "$SECRET"
recreate_server
echo "testeur retiré"
REMOTE
)
