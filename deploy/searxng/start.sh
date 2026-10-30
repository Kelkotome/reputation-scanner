#!/bin/sh
set -eu
umask 077
if [ "$#" -ne 1 ]; then
  printf '%s\n' 'Usage: sudo sh start.sh sha256:IMAGE_ID (or registry/image@sha256:DIGEST)' >&2
  exit 2
fi
image_ref=$1
case "$image_ref" in
  sha256:*) image_digest=${image_ref#sha256:} ;;
  *@sha256:*) image_digest=${image_ref##*@sha256:} ;;
  *) printf '%s\n' 'An immutable SHA-256 image reference is required.' >&2; exit 2 ;;
esac
case "$image_digest" in *[!0123456789abcdef]*|'') exit 2 ;; esac
[ "${#image_digest}" -eq 64 ] || exit 2
[ "$(id -u)" -eq 0 ] || { printf '%s\n' 'Run as root on the dedicated Linux Docker host.' >&2; exit 2; }
command -v docker >/dev/null
command -v python3 >/dev/null
docker image inspect "$image_ref" >/dev/null
if docker container inspect reputation-searxng >/dev/null 2>&1; then
  printf '%s\n' 'Container reputation-searxng already exists. Review it before replacing it.' >&2
  exit 1
fi
recipe_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# Fixed separate directory. Never use another service's config/data volume.
state_dir=/var/lib/123-reputation-searxng
config_dir=$state_dir/config
if [ -e "$state_dir" ] && [ ! -f "$state_dir/.reputation-owned" ]; then
  printf '%s\n' 'Refusing an existing state directory without this recipe ownership marker.' >&2
  exit 1
fi
mkdir -p "$config_dir"
chmod 700 "$state_dir" "$config_dir"
touch "$state_dir/.reputation-owned"
# Secret generated only at deployment outside the repo, never printed or put
# in Docker CLI/environment values, reused on subsequent starts.
python3 - "$recipe_dir/settings.template.yml" "$state_dir" <<'PY'
import os
import pathlib
import re
import secrets
import sys
template_path, state_path = map(pathlib.Path, sys.argv[1:])
secret_path = state_path / "secret"
if not secret_path.exists():
    fd = os.open(secret_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write(secrets.token_hex(32))
secret = secret_path.read_text().strip()
if not re.fullmatch(r"[0-9a-f]{64}", secret):
    raise SystemExit("Invalid dedicated secret file; refusing to start.")
template = template_path.read_text()
if template.count("__RUNTIME_SECRET__") != 1:
    raise SystemExit("Invalid settings template; refusing to start.")
target = state_path / "config" / "settings.yml"
temporary = target.with_suffix(".tmp")
with open(temporary, "w") as handle:
    os.chmod(temporary, 0o600)
    handle.write(template.replace("__RUNTIME_SECRET__", secret))
os.replace(temporary, target)
PY
docker run --detach --pull=never --name reputation-searxng \
  --label app=123-reputation-private-search \
  --restart unless-stopped --init \
  --publish 127.0.0.1:8890:8080 \
  --cpus 1 --memory 512m --memory-swap 512m --pids-limit 128 \
  --ulimit core=0 --cap-drop ALL --security-opt no-new-privileges:true \
  --read-only --log-driver none \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
  --tmpfs /var/cache/searxng:rw,nosuid,nodev,noexec,size=32m,mode=1777 \
  --mount "type=bind,src=$config_dir,dst=/etc/searxng,readonly" \
  --mount "type=bind,src=$recipe_dir,dst=/opt/reputation-private,readonly" \
  --env SEARXNG_DEBUG=false --env SEARXNG_LIMITER=false \
  --env SEARXNG_PUBLIC_INSTANCE=false --env SEARXNG_IMAGE_PROXY=false \
  --env SEARXNG_VALKEY_URL= --env SEARXNG_REDIS_URL= \
  --env GRANIAN_LOG_ENABLED=false --env GRANIAN_LOG_ACCESS_ENABLED=false \
  --entrypoint /bin/sh "$image_ref" /opt/reputation-private/private-entrypoint.sh
