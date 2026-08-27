#!/bin/sh
set -e

# پوشه داده معمولاً از هاست bind-mount می‌شود و مالکیتش root است.
# اینجا (به عنوان root) مالکیت را به کاربر node می‌دهیم و بعد
# با su-exec امتیاز را می‌اندازیم تا خود برنامه با root اجرا نشود.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u node)" ]; then
    echo "[entrypoint] اصلاح مالکیت $DATA_DIR ..."
    chown -R node:node "$DATA_DIR"
  fi
  exec su-exec node "$@"
fi

exec "$@"
