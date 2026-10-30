# Dedicated reputation SearXNG

## Active Windows connection — HTTPS gateway

The Windows app now uses the owner's supplied HTTPS gateway. Set `SEARXNG_URL` and `SEARXNG_PROXY_KEY` privately in `.env`; the Worker sends the `X-Proxy-Key` header over HTTPS. Bearer and Cloudflare Access configurations remain supported. Direct and Worker-relayed neutral searches passed on 27 September. No local install or SSH tunnel is required with this gateway; the tunnel instructions below are historical/alternative setup.

## Windows local connection — 27 September 2026

The copied repository contains the adapter and deployment recipe, not a running search service or its SSH key. This Windows copy has no listener at port 8890. Connect the dedicated service using the existing key (supply its local file path privately) or configure an authenticated HTTPS gateway in `.env`. Then run `npm run check:live` and `npm run dev:live` from the app directory. Live startup uses port 8788 and fails if the connection returns empty/incomplete results; no demo fallback occurs.

The adapter now requests `safesearch=0`, and the dedicated instance template uses `safe_search: 0`, as requested for general reputation searches. Changing the template does not update an existing VPS container: its active settings and engine support must be verified after access is restored. The app's own specialist-content workflow remains in place.

This recipe creates only `reputation-searxng`, bound to VPS loopback
`127.0.0.1:8890`. It does not change any other SearXNG service on the host, its volumes, engine settings,
proxy or public hostnames. The owner authorised this dedicated instance; it was deployed and verified on 25 September 2026.

## Start on the VPS

Copy this directory to `/opt/123-reputation-searxng`, review it, then run:

```sh
cd /opt/123-reputation-searxng
sudo sh start.sh sha256:f433294b46a93564993c4371005341e013d94aa8ea4662d8ee521cd2cccb08e8
```

That **local image ID** was observed for `2026.7.12+c19d86faa` on the VPS; it is
not a registry manifest digest. The script requires the image locally and
never pulls `latest`. Other versions require a reviewed immutable ID/digest.
Recheck settings and the entrypoint before upgrades; updates are not automatic.

The dedicated secret is created only at runtime, outside the repository, in
`/var/lib/123-reputation-searxng`. Only configuration persists. The verified
image defaults to root, so root-only settings are readable; capabilities are
removed and its filesystem is read-only. The launcher bypasses stock
ownership/certificate writes, retains the image working directory, and supports
the known Granian `venv` and `.venv` locations. Unknown layouts fail closed.

`keep_only` retains **only `google cse`**, assigned to `general`. Other engines
are removed, not merely disabled. Results are JSON only. Autocomplete,
favicon resolution, image proxying, metrics, optional plugins and Valkey are
disabled. A request's `engines` parameter is not the isolation boundary.

### Planned three-engine coverage

The owner selected the global top three: Google, Bing and Yahoo, using
[Statcounter's August 2026 worldwide figures](https://gs.statcounter.com/search-engine-market-share).
The intended adapter setting is `SEARXNG_ENGINES=google cse,bing,yahoo` with
a matching instance `keep_only` list and enabled general-web engine entries.
The adapter already accepts this set and returns at most 20 combined results.

Do not activate that configuration solely because the names load. A separate,
loopback-only test container using the pinned image enabled exactly those three
engines. Google returned 20 results for `example.com`; Bing returned 10 for
`wikipedia` but none for `example.com` or `OpenStreetMap`; Yahoo returned none
for all three. Those empty responses did not report engine errors. The combined
`example.com` response contained Google results only. The temporary test
container was removed. The existing live service and local app remain Google-only.

Before rollout, investigate adapter/version or upstream-response compatibility
and validate individual-engine responses from the intended hosting environment.
Preserve the existing logging, transient processing and media restrictions.
Reported partial failures are already surfaced by the app, but silent empty
responses cannot be treated as verified engine health or exhaustive coverage.

Non-query checks after deployment:

```sh
docker inspect --format '{{.State.Status}} {{.State.ExitCode}} {{.HostConfig.LogConfig.Type}}' reputation-searxng
docker port reputation-searxng
curl --fail --silent --output /dev/null http://127.0.0.1:8890/healthz
```

Expect running, log driver `none`, and only `127.0.0.1:8890` published. Startup
logs are intentionally unavailable: inspect exit state and pinned settings.
The deployment owner must verify the loaded allowlist/logging on the actual
image before sensitive use. Runtime verification returned only `google cse`; a neutral `example.com` POST returned 20 results with no failed engines. The existing research instance remained running.

## Local MVP tunnel

Run on the local development machine and keep it open (the current preview already has a background tunnel):

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -L 127.0.0.1:8890:127.0.0.1:8890 -i "<path-to-your-ssh-key>" <ssh-user>@<your-vps-ip>
```

The local MVP relay can use `http://127.0.0.1:8890`. A deployed cloud Worker
cannot use this workstation tunnel. Local processes and privileged VPS
operators can reach the listener. No public ingress, DNS or TLS proxy is added.

## Retention boundary

The MVP must POST searches and avoid its own query/body logs. Here Granian
access/application logs are disabled, Python logging is disabled before app
imports, process output is discarded, and Docker uses its `none` log driver.
`debug: false` alone still allows SearXNG warning/error logs.

No persistent result/cache volume is mounted. Cache/temp paths use bounded
tmpfs; the root filesystem is read-only. Core dumps and container swap are
disabled. Host swap, crash dumps, snapshots, packet capture and monitoring must
not retain sensitive processing. Docker warns tmpfs may otherwise be swapped;
these controls do not promise secure memory erasure or constrain host admins.

Queries/results still pass through the local relay and VPS in memory. The
operator can observe that processing, and Google receives the queries from
the VPS. These settings provide **no zero-retention guarantee for upstream
search engines, the VPS host or any later proxy**. No upstream retention
agreement is implied. Browser-only records and explicit assistance sharing
remain separate MVP controls.

Stop only this instance with `docker stop reputation-searxng`. For a reviewed
replacement, stop/remove only this named container and rerun the script.
Never edit/remove other services' containers or volumes for this recipe.

## Official references checked 2026-09-25

- [Container installation](https://docs.searxng.org/admin/installation-docker.html)
- [Engine keep_only](https://docs.searxng.org/admin/settings/settings.html#engines-keep-only)
- [Search formats/autocomplete](https://docs.searxng.org/admin/settings/settings_search.html)
- [Production logging source](https://github.com/searxng/searxng/blob/master/searx/__init__.py)
- [Granian logging flags](https://github.com/emmett-framework/granian#options)
- [Python logging.disable](https://docs.python.org/3/library/logging.html#logging.disable)
- [Docker tmpfs/swap limitation](https://docs.docker.com/engine/storage/tmpfs/)

The local `.env` selects `searxng`, allows the loopback tunnel and enables the relay. Public access allows three scan starts per IP per UTC day, up to 12 queries per scan, and a shared 300-request daily budget. Authenticated operators bypass daily caps and can run up to 60 queries per scan. See [operator access and metering](../../scripts/operator-dashboard.md). Existing API keys are preserved but are not used by this provider. Restart the app with `npm run dev:live` after opening the tunnel. Public deployment remains disabled by default.
