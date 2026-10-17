# Synelia fork: shared by add-tester.sh / remove-tester.sh. Runs ON konnect (sent over ssh).
# Never prints a secret. Every env file is backed up first and stays chmod 600.
set -euo pipefail
DIR=/srv/synelia-bot
cd "$DIR"
EMAIL=$(printf '%s' "$1" | tr 'A-Z' 'a-z')
[[ "$EMAIL" =~ ^[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "email invalide" >&2; exit 2; }
SLUG=$(printf '%s' "$EMAIL" | tr 'a-z' 'A-Z' | tr -c 'A-Z0-9\n' '_')
NAME=$(printf '%s' "${EMAIL%@*}" | tr -c 'a-z0-9.\n' '-')
SECRET="$DIR/secrets/testers/$EMAIL.txt"
STAMP=$(date +%Y%m%d-%H%M%S)
backup() {
  mkdir -p backup && chmod 700 backup
  for f in .env .env.server; do cp -p "$f" "backup/$f.$STAMP.tester" && chmod 600 "backup/$f.$STAMP.tester"; done
}
others() { docker ps --format '{{.ID}} {{.Names}} {{.Status}}' | grep -v ' synelia-bot-' | awk '{print $1, $2}' | sort; }
recreate_server() {
  local before after
  before=$(others)
  docker compose up -d --no-deps server >/dev/null 2>&1
  after=$(others)
  if [ "$before" = "$after" ]; then echo "autres stacks intactes ($(printf '%s\n' "$before" | wc -l) conteneurs inchangés)"; else echo "ATTENTION: conteneurs hors synelia changés" >&2; exit 4; fi
}
psql_q() { docker compose exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v email='$EMAIL' -tA" ; }
