#!/usr/bin/env bash
# Synelia fork: set-role.sh [--dry-run] <email> user|admin — give an EXISTING account exactly one
# role, from the operator's machine (pilot: role changes never go through the admin screen).
#  - user  : drops the email from INITIAL_ADMIN_EMAILS (otherwise the next sign-in re-promotes it,
#            auth/roles.ts applyConfiguredAdmin), then user_roles = {user} in one transaction;
#  - admin : adds the email to INITIAL_ADMIN_EMAILS (same mechanism as add-tester.sh --role admin),
#            then user_roles = {admin}.
# .env.server is backed up first and stays chmod 600; only the synelia server is recreated and the
# other stacks are checked unchanged. Nothing secret is printed.
# WARNING: recreates the synelia server container: run it only in an announced window.
set -euo pipefail
# --force-cut (first argument) or FORCE_CUT=1: recreate even if chat runs are still in flight after the
# 120 s wait (see inflight-check.sh).
if [ "${1:-}" = --force-cut ]; then FORCE_CUT=1; shift; fi
DRY=0; [ "${1:-}" = --dry-run ] && { DRY=1; shift; }
[ $# -eq 2 ] || { echo "usage: $0 [--dry-run] <email> user|admin" >&2; exit 2; }
case "$2" in user|admin) ;; *) echo "rôle invalide: $2 (user|admin)" >&2; exit 2 ;; esac
[[ "$1" =~ ^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || { echo "email invalide" >&2; exit 2; }
echo "AVERTISSEMENT : ce script recrée le conteneur server synelia (coupure de quelques secondes pour tous). Fenêtre annoncée uniquement."
if [ "$DRY" = 1 ]; then
  echo "dry-run: $1 -> rôle $2 ($([ "$2" = user ] && echo 'retrait de' || echo 'ajout à') INITIAL_ADMIN_EMAILS, user_roles={$2}), puis recréerait le server. Rien n'a été fait."
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
ssh "$HOST" "NEW_ROLE=$2 bash -s -- '$1'" < <(cat "$HERE/tester-common.sh"; cat <<'REMOTE'
n=$(printf "SELECT count(*) FROM users WHERE email = :'email';\n" | psql_q | tr -d '[:space:]')
[ "$n" = 1 ] || { echo "compte introuvable" >&2; exit 3; }
backup
EMAIL="$EMAIL" NEW_ROLE="$NEW_ROLE" python3 - <<'PY'
import os
p='.env.server'; lines=open(p).read().split('\n'); e=os.environ['EMAIL']; admin=os.environ['NEW_ROLE']=='admin'; done=False
for i,l in enumerate(lines):
    if l.startswith('INITIAL_ADMIN_EMAILS='):
        v=l.split('=',1)[1].strip().strip('"\'')
        items=[x.strip() for x in v.split(',') if x.strip() and x.strip().lower()!=e]
        if admin: items.append(e)
        lines[i]='INITIAL_ADMIN_EMAILS='+','.join(items); done=True
if admin and not done: lines.insert(len(lines)-1 if lines and lines[-1]=='' else len(lines),'INITIAL_ADMIN_EMAILS='+e)
open(p,'w').write('\n'.join(lines))
PY
chmod 600 .env.server
listed=$(grep '^INITIAL_ADMIN_EMAILS=' .env.server | cut -d= -f2- | tr -d '"'"'"'"' | tr ',' '\n' | tr 'A-Z' 'a-z' | sed 's/^ *//;s/ *$//' | grep -cxF "$EMAIL" || true)
if [ "$NEW_ROLE" = user ] && [ "$listed" != 0 ]; then echo "toujours dans INITIAL_ADMIN_EMAILS" >&2; exit 7; fi
printf "BEGIN;\nDELETE FROM user_roles WHERE user_id = (SELECT id FROM users WHERE email = :'email') AND role::text <> :'role';\nINSERT INTO user_roles (user_id, role) SELECT id, :'role' FROM users WHERE email = :'email' ON CONFLICT DO NOTHING;\nCOMMIT;\n" |
  docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -v email='$EMAIL' -v role='$NEW_ROLE' -tA" >/dev/null
recreate_server
role=$(printf "SELECT coalesce(string_agg(r.role::text, ','), 'aucun') FROM users u LEFT JOIN user_roles r ON r.user_id=u.id WHERE u.email = :'email';\n" | psql_q | tr -d '[:space:]')
echo "rôle: $role ; INITIAL_ADMIN_EMAILS: $([ "$listed" = 0 ] && echo absent || echo présent)"
[ "$role" = "$NEW_ROLE" ] || { echo "rôle inattendu" >&2; exit 8; }
REMOTE
)
remote_rc=$?
set -e
inflight_cut_report "$INFLIGHT_OLD_START"
exit $remote_rc
