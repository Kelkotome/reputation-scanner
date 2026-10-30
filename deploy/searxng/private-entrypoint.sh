#!/bin/sh
set -eu
# Discard output before startup, independently of Docker's retention settings.
exec >/dev/null 2>&1
ulimit -c 0
export PYTHONPATH="/opt/reputation-private${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONDONTWRITEBYTECODE=1
export SEARXNG_DEBUG=false
export SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml
export GRANIAN_LOG_ENABLED=false
export GRANIAN_LOG_ACCESS_ENABLED=false

# Known older/current image locations. No runtime installs or downloads.
if [ -x /usr/local/searxng/.venv/bin/granian ]; then
  granian_bin=/usr/local/searxng/.venv/bin/granian
elif [ -x /usr/local/searxng/venv/bin/granian ]; then
  granian_bin=/usr/local/searxng/venv/bin/granian
else
  exit 127
fi
# Bypass stock ownership/CA writes; retain the image's working directory.
exec "$granian_bin" --interface wsgi --host 0.0.0.0 --port 8080 \
  --workers 1 --blocking-threads 4 --no-log --no-access-log searx.webapp:app
