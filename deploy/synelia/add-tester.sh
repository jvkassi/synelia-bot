#!/usr/bin/env bash
# Synelia fork: add-tester.sh <email> — one pilot tester, from the operator's machine.
#  - app account (role user, must_change_password=true) via SYNELIA_TESTER_<SLUG>_* in .env.server,
#    created by the server's bootstrap on restart (never rotates an existing password);
#  - its own bcrypt basicauth entry, named after the tester, appended to BASICAUTH_USERS in .env;
#  - both secrets ONLY in /srv/synelia-bot/secrets/testers/<email>.txt (chmod 600, never overwritten);
#  - recreates only the synelia server container and checks the other stacks did not move.
# Nothing secret is printed.
set -euo pipefail
[ $# -eq 1 ] || { echo "usage: $0 <email>" >&2; exit 2; }
HOST=${HOST:-konnect}
HERE=$(cd "$(dirname "$0")" && pwd)
ssh "$HOST" "bash -s -- '$1'" < <(cat "$HERE/tester-common.sh"; cat <<'REMOTE'
[ -e "$SECRET" ] && { echo "existe déjà: secrets/testers/$EMAIL.txt (jamais écrasé)" >&2; exit 3; }
grep -q "^SYNELIA_TESTER_${SLUG}_EMAIL=" .env.server && { echo "testeur déjà présent dans .env.server" >&2; exit 3; }
grep -q "^BASICAUTH_USERS=.*[',]$NAME:" .env && { echo "entrée basicauth '$NAME' déjà présente" >&2; exit 3; }
free -m | sed -n 2p
APP_PW=$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-20)
BASIC_PW=$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-20)
HASH=$(printf '%s' "$BASIC_PW" | docker compose exec -T server bun -e 'const pw=(await Bun.stdin.text());console.log(await Bun.password.hash(pw,{algorithm:"bcrypt",cost:10}))')
[[ "$HASH" == \$2* ]] || { echo "hash bcrypt invalide" >&2; exit 5; }
backup
umask 077
mkdir -p secrets/testers && chmod 700 secrets/testers
( set -o noclobber; printf 'email=%s\napp_password=%s\nbasicauth_user=%s\nbasicauth_password=%s\nurl=https://synelia-bot.labs.synelia.tech\n' "$EMAIL" "$APP_PW" "$NAME" "$BASIC_PW" > "$SECRET" )
chmod 600 "$SECRET"
printf 'SYNELIA_TESTER_%s_EMAIL=%s\nSYNELIA_TESTER_%s_PASSWORD=%s\n' "$SLUG" "$EMAIL" "$SLUG" "$APP_PW" >> .env.server
NAME="$NAME" HASH="$HASH" python3 - <<'PY'
import os,re
p='.env'; lines=open(p).read().split('\n')
for i,l in enumerate(lines):
    if l.startswith('BASICAUTH_USERS='):
        v=l.split('=',1)[1]; q=v[0] if v[:1] in "'\"" else ''
        inner=v[1:-1] if q else v
        lines[i]='BASICAUTH_USERS='+q+inner+','+os.environ['NAME']+':'+os.environ['HASH']+q
open(p,'w').write('\n'.join(lines))
PY
chmod 600 .env .env.server
unset APP_PW BASIC_PW HASH
recreate_server
for i in $(seq 1 30); do
  ok=$(printf "SELECT (count(*)=1 AND bool_and(must_change_password))::text FROM users WHERE email = :'email';\n" | psql_q 2>/dev/null | tr -d '[:space:]') || ok=""
  [ "$ok" = "true" ] && break; sleep 2
done
[ "$ok" = "true" ] && echo "compte créé: must_change_password=true" || { echo "compte non créé (voir logs server)" >&2; exit 6; }
role=$(printf "SELECT coalesce(string_agg(r.role::text, ','), 'aucun') FROM users u LEFT JOIN user_roles r ON r.user_id=u.id WHERE u.email = :'email';\n" | psql_q 2>/dev/null | tr -d '[:space:]') || role="?"
echo "rôle: $role"
echo "secrets: secrets/testers/$EMAIL.txt (chmod 600, non affichés)"
REMOTE
)
