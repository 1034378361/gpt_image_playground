#!/bin/sh
set -eu

DATA_DIR="${GIP_DATA_DIR:-/app/backend/data}"
DB_PATH="${GIP_DATABASE_PATH:-$DATA_DIR/app.sqlite3}"
BACKUP_ENABLED="${GIP_STARTUP_BACKUP_ENABLED:-true}"
BACKUP_RETENTION="${GIP_STARTUP_BACKUP_RETENTION:-5}"
BACKUP_DIR="${GIP_STARTUP_BACKUP_DIR:-$DATA_DIR/startup-backups}"

mkdir -p "$DATA_DIR"
mkdir -p "$(dirname "$DB_PATH")"

case "$BACKUP_RETENTION" in
  ''|*[!0-9]*)
    BACKUP_RETENTION=5
    ;;
esac

if [ "$BACKUP_ENABLED" = "true" ] || [ "$BACKUP_ENABLED" = "1" ] || [ "$BACKUP_ENABLED" = "yes" ]; then
  if [ -f "$DB_PATH" ]; then
    mkdir -p "$BACKUP_DIR"
    TS="$(date +%Y%m%d-%H%M%S)"
    BACKUP_PATH="$BACKUP_DIR/app-$TS.sqlite3"
    META_PATH="$BACKUP_DIR/app-$TS.meta"
    cp "$DB_PATH" "$BACKUP_PATH"
    {
      echo "app_version=${GIP_APP_VERSION:-unknown}"
      echo "vcs_ref=${GIP_VCS_REF:-unknown}"
      echo "build_date=${GIP_BUILD_DATE:-unknown}"
      echo "source_db=$DB_PATH"
      echo "created_at=$TS"
    } > "$META_PATH"
    echo "[entrypoint] Startup backup created: $BACKUP_PATH"

    if [ "$BACKUP_RETENTION" -gt 0 ]; then
      INDEX=0
      for FILE in $(ls -1t "$BACKUP_DIR"/app-*.sqlite3 2>/dev/null || true); do
        INDEX=$((INDEX + 1))
        if [ "$INDEX" -gt "$BACKUP_RETENTION" ]; then
          rm -f "$FILE" "${FILE%.sqlite3}.meta"
        fi
      done
    fi
  else
    echo "[entrypoint] No database found yet, skipping startup backup."
  fi
else
  echo "[entrypoint] Startup backup disabled."
fi

exec "$@"
