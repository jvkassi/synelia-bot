#!/usr/bin/env bash
# Synelia fork: add-tester.sh <email> — one pilot tester, from the operator's machine.
#  - app account (role user, must_change_password=true) via SYNELIA_TESTER_<SLUG>_* in .env.server,
#    created by the server's bootstrap on restart (never rotates an existing password);
#  - its own bcrypt basicauth entry, named after the tester, appended to BASICAUTH_USERS in .env;
#  - both secrets ONLY in /srv/synelia-bot/secrets/testers/<email>.txt (chmod 600, never overwritten);
#  - recreates only the synelia server container and checks the other stacks did not move.
# Nothing secret is printed.
#  --role admin : also appends the email to INITIAL_ADMIN_EMAILS in .env.server, so the account is
#                 created with role admin (same mechanism as the operator admins); default role user.
#  --dry-run    : checks the arguments and prints what would happen; touches nothing.
#  --force-cut  : recreate even if chat runs are still in flight after the 120 s wait (see inflight-check.sh).
# WARNING: recreates the synelia server container (a few seconds of 502 for everyone): run it only
# in an announced window.
set -euo pipefail
ROLE=user; DRY=0; EMAIL_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE=${2:-}; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --force-cut) FORCE_CUT=1; shift ;;
    -*) echo "option inconnue: $1" >&2; exit 2 ;;
    *) [ -z "$EMAIL_ARG" ] || { echo "un seul email" >&2; exit 2; }; EMAIL_ARG=$1; shift ;;
  esac
done
[ -n "$EMAIL_ARG" ] || { echo "usage: $0 [--role user|admin] [--dry-run] <email>" >&2; exit 2; }
case "$ROLE" in user|admin) ;; *) echo "rôle invalide: $ROLE (user|admin)" >&2; exit 2 ;; esac
[[ "$EMAIL_ARG" =~ ^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "email invalide" >&2; exit 2; }
echo "AVERTISSEMENT : ce script recrée le conteneur server synelia (coupure de quelques secondes pour tous). Fenêtre annoncée uniquement."
if [ "$DRY" = 1 ]; then
  echo "dry-run: créerait $EMAIL_ARG (rôle $ROLE, must_change_password=true, entrée basicauth propre)$([ "$ROLE" = admin ] && echo ', ajout à INITIAL_ADMIN_EMAILS'), puis recréerait le server. Rien n'a été fait."
  exit 0
fi
HOST=${HOST:-konnect}
HERE=$(cd "$(dirname "$0")" && pwd)
# Synelia fork: no chat run in flight before the recreate (bounded wait, abort unless --force-cut /
# FORCE_CUT=1), then the runs the recreate cut, for the announcement. See inflight-check.sh.
# shellcheck source=inflight-check.sh
. "$(cd "$(dirname "$0")" && pwd)/inflight-check.sh"
inflight_gate 120 || exit $?
INFLIGHT_OLD_START=$INFLIGHT_LAST_STARTED
set +e
ssh "$HOST" "ROLE=$ROLE bash -s -- '$EMAIL_ARG'" < <(cat "$HERE/tester-common.sh"; cat <<'REMOTE'
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
if [ "${ROLE:-user}" = admin ]; then
  EMAIL="$EMAIL" python3 - <<'PY'
import os
p='.env.server'; lines=open(p).read().split('\n'); e=os.environ['EMAIL']; done=False
for i,l in enumerate(lines):
    if l.startswith('INITIAL_ADMIN_EMAILS='):
        v=l.split('=',1)[1].strip().strip('"\'')
        items=[x.strip() for x in v.split(',') if x.strip()]
        if e not in [x.lower() for x in items]: items.append(e)
        lines[i]='INITIAL_ADMIN_EMAILS='+','.join(items); done=True
if not done: lines.insert(len(lines)-1 if lines and lines[-1]=='' else len(lines),'INITIAL_ADMIN_EMAILS='+e)
open(p,'w').write('\n'.join(lines))
PY
fi
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
remote_rc=$?
set -e
inflight_cut_report "$INFLIGHT_OLD_START"
exit $remote_rc
