# General web coverage

Updated 1 October 2026. SSH access to `<your-vps-ip>` is verified. Following explicit approval and isolated tests, the dedicated `reputation-searxng` service now runs official version `2026.9.30+a9d990033` with **Google, Bing and Google CSE**. The local app requests those three engines. Its public allowance remains 24 query requests. The separate stock `searxng` service was not changed.

The previous July image returned zero results from regular Google and Brave on all three neutral queries. The [upstream Google repair](https://github.com/searxng/searxng/pull/6546) was merged after that build. The downloaded replacement is pinned to an immutable digest; no unpinned image was applied.

The selected combination returned 31–32 distinct listings with attribution to all three engines, compared with CSE's twenty alone. Google occasionally returned empty standalone responses. Bing supports only its first page in this version; Google and CSE support later pages. Brave returned none. DuckDuckGo returned results alone but did not contribute to the combined tests and was not selected.

The first live replacement passed direct probes but missed the existing gateway Docker network and returned HTTP 502 externally. It was rolled back successfully. The accepted replacement preserves both `bridge` and `<gateway-docker-network>`, as well as the existing private secret, TLS proxy, authentication, read-only mounts, logging suppression and resource controls.

Authenticated HTTPS gateway checks verified each engine's own usable results. The local app's normal relay returned 31 page-one results from all three engines, then 29 page-two results with 25 new URLs from Google/CSE, without partial-engine status. Test queries were neutral; no personal search, source page, media, email or contact submission was performed.

The startup check now probes configured engines separately using bounded neutral queries. CSE results cannot validate a selected Google or Bing engine. UI labels distinguish configured engines from engines observed in a scan. A successful probe establishes limited connectivity, not exhaustive coverage.

[`settings.general-web.template.yml`](settings.general-web.template.yml) records the tested engine settings. Never install its runtime-secret placeholder or rerun `start.sh` as an update procedure. The [compatibility report](COMPATIBILITY-TEST.md) records the tests; [LIVE-UPGRADE.md](LIVE-UPGRADE.md) records the accepted upgrade and rollback resources. The previous container and private settings backup are retained.

Broader engines cannot guarantee the same list as Google.com. The missing screenshot URLs have not been verified as recovered. Existing saved scans remain historical; refresh the local page and start a new scan to use the expanded configuration.
