# Pinned SearXNG compatibility test

Completed 1 October 2026 following the user's explicit approval to download and test an immutable official image in a private container. A separately approved live upgrade was subsequently applied and accepted; its gateway and local relay checks passed.

## Image and isolation

Official version: `2026.9.30-a9d990033`.

```text
docker.io/searxng/searxng@sha256:a07a5cd2da2c63d66e559f9e4d3a3db106cfc6c32fb0ac70abe91cc28bcd7350
```

Docker reported the expected immutable image ID. The image retains `/usr/local/searxng` as its working directory. The existing private entrypoint started it successfully. Its Python 3.14.7 runtime loaded the private `sitecustomize.py` and disabled logging.

The temporary `reputation-searxng-compat-test` used loopback `127.0.0.1:8891`, a separate read-only configuration, read-only root filesystem, dropped capabilities, no-new-privileges, Docker log driver `none`, disabled application/access logging, one CPU, 512 MiB memory with no additional swap, PID bounds, no core dumps and bounded temporary filesystems. The current dedicated and stock services stayed running. Each candidate's loaded engine allowlist was verified before requests.

Only neutral general-web JSON searches were used: `example.com`, `wikipedia`, `OpenStreetMap`, and `open source software`. No personal query, image search, source-page fetch or media retrieval was used. Only numeric diagnostics and public engine labels were retained.

## Results

| Engine | Observed first-page results | Second-page results | Decision |
| --- | --- | --- | --- |
| Google CSE | 20 on each initial query | 20, including 18 new OpenStreetMap URLs | Keep as fallback |
| Regular Google | Intermittent 0–10 alone; 9–10 in final combined queries | 9–10 on successful probes, including new URLs | Useful broader source, limited reliability |
| Brave | 0 on all initial queries | 0 | Reject |
| DuckDuckGo | 10 alone on successful probes | 15 new URLs for two queries; 0 for another | Reject this candidate: absent from combined results |
| Bing | 10 on every first-page probe | Unsupported | Use for additional first-page coverage |

The final **Google + Bing + CSE** combination returned 32 distinct listings for each of three neutral queries, attributed to all three engines, with no reported failed engines. An earlier combined query returned 31. Nonempty responses alone do not prove all selected engines work; attribution was checked per engine and in the combined responses. Empty responses without a failed-engine status do not establish an IP block or parser cause.

[Bing's official engine documentation](https://docs.searxng.org/dev/engines/online/bing.html) states that pagination is unsupported because it depends on JavaScript. Its zero-result second-page responses therefore do not indicate an engine failure. Google and CSE provide later-page coverage.

These tests show broader first-page coverage, not exhaustive discovery or dependable pagination from every engine. They do not establish recovery of the user's missing screenshot URLs.

## Current state

The temporary container was removed after every final test. The accepted live container now runs `2026.9.30+a9d990033` with Google, Bing and CSE. The original July container and private settings are retained for rollback; see the upgrade record.

The tested Google/Bing/CSE settings remain privately in `/var/lib/123-reputation-searxng/compat-test-20261001/settings.yml`. The image remains downloaded. [LIVE-UPGRADE.md](LIVE-UPGRADE.md) records the applied replacement, end-to-end acceptance and rollback resources.

