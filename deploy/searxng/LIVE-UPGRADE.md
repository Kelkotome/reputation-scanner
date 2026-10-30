# Live search upgrade and rollback

Applied and accepted 1 October 2026 after explicit user approval. The first attempt was rolled back after the gateway returned 502; the accepted retry preserves its original Docker networks. Authenticated gateway and local relay checks passed. The following procedure records the applied change and rollback method.

## Concrete change

Replace only `reputation-searxng` on `<your-vps-ip>` with the already downloaded immutable official image:

```text
docker.io/searxng/searxng@sha256:a07a5cd2da2c63d66e559f9e4d3a3db106cfc6c32fb0ac70abe91cc28bcd7350
```

Use the tested **Google, Bing and Google CSE** general-web allowlist. Keep the existing HTTPS proxy, authentication, runtime secret, private entrypoint, restrictive filesystem permissions, disabled logs and media features, resource limits and loopback `127.0.0.1:8890` listener. The change needs a brief search-service restart. The separate stock container remains outside this procedure.

The [test results](COMPATIBILITY-TEST.md) demonstrate added first-page listings. Google can still return empty responses. Bing deliberately supports only its first page in this version; Google and CSE support later pages. This upgrade cannot guarantee Google.com parity or recovery of particular URLs.

## Replacement and acceptance

1. Reconfirm the current container's identity, image `sha256:f433294b46a93564993c4371005341e013d94aa8ea4662d8ee521cd2cccb08e8`, loopback binding, private mounts, running state, disabled logs and **all Docker network attachments**. This service also needs `<gateway-docker-network>` for the existing Docker gateway. Verify the new immutable image is already available. Verify no temporary test container exists.
2. Parse both settings privately and require identical runtime secrets and identical non-engine sections. Reject placeholders and unexpected changes. Confirm the candidate allowlist is exactly Google, Bing and CSE. Preserve the current settings and selected Docker metadata in a timestamped, root-only backup directory. Use a unique rollback-container name.
3. Stop the dedicated container and rename it to the rollback name. Atomically install the validated settings with mode 0600. Do not modify the shared private entrypoint or logging module.
4. Create `reputation-searxng` from the pinned image with `--pull=never`, the same private entrypoint and read-only mounts, `--restart unless-stopped`, `--init`, loopback port 8890, one CPU, 512 MiB memory/swap, PID limit 128, core limit zero, all capabilities dropped, no-new-privileges, read-only root filesystem, log driver `none`, and the existing bounded `/tmp` and cache tmpfs. Preserve the existing safe environment controls. Attach it to the original `<gateway-docker-network>` network and preserve existing aliases before gateway acceptance; a bridge-only replacement produces HTTP 502 despite passing loopback tests.
5. Require health, the expected version, the exact three-engine allowlist and all hardening settings. Probe each engine separately with bounded neutral queries and require its own usable result attribution. Verify combined queries can include all three engines. Keep diagnostics to engine labels, status and counts.
6. Test the existing authenticated HTTPS gateway using the application adapter. Direct loopback success alone is insufficient. Roll back if the gateway or attribution checks fail.
7. Only after gateway acceptance, update the local private `.env` engine setting to `SEARXNG_ENGINES=google,bing,google cse`. Restart the local app, run its strict neutral preflight, and validate a neutral request through the local relay. Preserve all other environment values and browser-stored cases.
8. Retain the stopped original container, its image and private configuration backup after acceptance. A saved report remains historical; provider changes apply to new scans.

## Rollback

Identify a failed replacement by its exact container name, pinned image and expected private mounts. Stop and remove only that new dedicated container. Restore the private original settings **before** restarting the old container, because both containers bind the same settings directory. Rename the retained original container back to `reputation-searxng`, start it and verify CSE through the existing gateway.

If the app setting has changed, restore `SEARXNG_ENGINES=google cse` and restart the local app. Require its neutral preflight and relay checks to pass. Never remove the original image, credentials, private recipe files or stock service during rollback.

## Retained rollback resources

- Original stopped container: `reputation-searxng-rollback-20261001T111658Z`.
- Original image: `sha256:f433294b46a93564993c4371005341e013d94aa8ea4662d8ee521cd2cccb08e8`.
- Root-only settings and Docker metadata: `/var/lib/123-reputation-searxng/backups/general-web-upgrade-20261001T111658Z`.
- Current dedicated container: `reputation-searxng`, image/version and both network attachments verified.
- App engine setting: `google,bing,google cse`; rollback setting: `google cse`.

Acceptance: gateway preflight verified Google 10 results (two neutral attempts), Bing 10 and CSE 20. Combined gateway response: 31 listings from all three. Local relay: HTTP 200 with 31 listings on page one, then 29 on page two including 25 new URLs. Later pages are attributed to Google and CSE. Test-only operator session closed after verification; the user's public scan allowance was not consumed.
