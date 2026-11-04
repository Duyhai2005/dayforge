#!/bin/sh
set -eu
umask 077

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

secret_hex() {
  strip_one_line_ending "$1" | od -An -vtx1 | tr -d ' \n'
}

root_password_hex=$(secret_hex /run/secrets/mysql_root_password)
app_password_hex=$(secret_hex /run/secrets/db_password)
migrator_password_hex=$(secret_hex /run/secrets/db_migrator_password)
[ -n "$root_password_hex" ] && [ -n "$app_password_hex" ] && [ -n "$migrator_password_hex" ]
sql_file=$(mktemp /tmp/dayforge-users.XXXXXX.sql)
trap 'rm -f "$sql_file"' EXIT HUP INT TERM

cat >"$sql_file" <<SQL
ALTER USER 'root'@'%' IDENTIFIED BY 0x${root_password_hex};
CREATE USER IF NOT EXISTS '${DB_USER}'@'%' IDENTIFIED BY 0x${app_password_hex};
ALTER USER '${DB_USER}'@'%' IDENTIFIED BY 0x${app_password_hex};
GRANT SELECT, INSERT, UPDATE, DELETE ON \`${DB_NAME}\`.* TO '${DB_USER}'@'%';
CREATE USER IF NOT EXISTS '${DB_MIGRATOR_USER}'@'%' IDENTIFIED BY 0x${migrator_password_hex};
ALTER USER '${DB_MIGRATOR_USER}'@'%' IDENTIFIED BY 0x${migrator_password_hex};
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_MIGRATOR_USER}'@'%';
SQL

MYSQL_PWD=$(strip_one_line_ending /run/secrets/mysql_root_password) mysql --protocol=TCP -h mysql -uroot --database=mysql <"$sql_file"
