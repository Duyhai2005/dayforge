#!/bin/sh
set -eu
umask 077
LC_ALL=C
export LC_ALL

case "$DB_NAME" in
  dayforge_staging|dayforge_production|dayforge_restore_*) ;;
  *) exit 1 ;;
esac
[ "$DB_USER" = dayforge_app ] || exit 1
[ "$DB_MIGRATOR_USER" = dayforge_migrator ] || exit 1

strip_one_line_ending() {
  file=$1
  size=$(wc -c <"$file" | tr -d ' ')
  ending=$(tail -c 2 "$file" | od -An -tx1 | tr -d ' \n')
  case "$ending" in
    *0d0a) size=$((size - 2)) ;;
    *0a|*0d) size=$((size - 1)) ;;
  esac
  [ "$size" -gt 0 ] || return 1
  head -c "$size" "$file"
}

secret_sql_literal() {
  value=$(strip_one_line_ending "$1") || return 1
  [ -n "$value" ] || return 1
  case "$value" in
    *[! -~]*) return 1 ;;
  esac
  escaped=$(printf '%s' "$value" | sed "s/'/''/g") || return 1
  printf "'%s'" "$escaped"
}

root_password_sql=$(secret_sql_literal /run/secrets/mysql_root_password)
app_password_sql=$(secret_sql_literal /run/secrets/db_password)
migrator_password_sql=$(secret_sql_literal /run/secrets/db_migrator_password)
[ -n "$root_password_sql" ] && [ -n "$app_password_sql" ] && [ -n "$migrator_password_sql" ]
sql_file=$(mktemp /tmp/dayforge-users.XXXXXX.sql)
trap 'rm -f "$sql_file"' EXIT HUP INT TERM

cat >"$sql_file" <<SQL
SET SESSION sql_mode = 'NO_BACKSLASH_ESCAPES';
ALTER USER 'root'@'%' IDENTIFIED BY ${root_password_sql};
CREATE USER IF NOT EXISTS '${DB_USER}'@'%' IDENTIFIED BY ${app_password_sql};
ALTER USER '${DB_USER}'@'%' IDENTIFIED BY ${app_password_sql};
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${DB_NAME}\`.* TO '${DB_USER}'@'%';
CREATE USER IF NOT EXISTS '${DB_MIGRATOR_USER}'@'%' IDENTIFIED BY ${migrator_password_sql};
ALTER USER '${DB_MIGRATOR_USER}'@'%' IDENTIFIED BY ${migrator_password_sql};
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_MIGRATOR_USER}'@'%';
SQL

MYSQL_PWD=$(strip_one_line_ending /run/secrets/mysql_root_password) mysql --protocol=TCP -h mysql -uroot --database=mysql <"$sql_file"
