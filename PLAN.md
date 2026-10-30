# Name Scanner: current handoff plan

## 0. Current direction — 25 September 2026

**This handoff supersedes earlier server-storage, cloud-AI and live-preview plans.** The project is this repository, the 123 Reputation Management Reputation Scanner app.

The owner requires scans, cases and saved work to remain in the browser, with assistance shared only through explicit contact. The active implementation uses IndexedDB and `src/private-worker.js`. Old scan/hit/takedown/help/unlock APIs return HTTP 410 before body or database access. Historical D1 content remains preserved and inaccessible to the active app; it has not been migrated or purged.

**Decision — 25 September:** the owner authorised proceeding with dedicated SearXNG on the existing VPS after being informed that our server and upstream engines temporarily process searches. This authorises local integration and neutral verification, not a search of a real person's name. The local preview may enable the SearXNG relay after verification; the public deployment default stays off. Visitors must still opt in. The active architecture never invokes cloud AI, source-page enrichment, media fetching, DNS or RDAP lookup.

Use the dedicated SearXNG service only, not any other shared research instance or AI/logging pipeline. See `deploy/searxng/README.md` for the pinned-image, loopback-only deployment and local tunnel. Only explicitly configured general-web engines may receive queries. SearXNG country context stays local; autocomplete is disabled. Never promise upstream zero retention. Partial engine responses must be labelled incomplete; complete engine failure must not look like a clean scan.

**Search-engine direction — 25 September:** use the three leading global search engines: Google, Bing and Yahoo (Statcounter, August 2026). SearXNG adapter names are `google cse,bing,yahoo`; the adapter already supports three engines. This is the target set, not the current live set. Isolated testing of the pinned VPS image loaded all three successfully, but Yahoo returned no results for three neutral queries and Bing returned results for only one. Keep the verified Google-only live configuration until the additional engines pass neutral runtime validation. An empty result without an engine error is not sufficient evidence of working coverage. See `VALIDATION.md`.

Consult [VALIDATION.md](VALIDATION.md) for current evidence and test counts. Offline tests/bundling do not establish hosted or real-browser acceptance. Public-host verification, deployment and real self-search precision acceptance remain pending.

**Additional owner decision:** add an internal aggregate usage/token-cost dashboard, authenticated operator searches without daily quotas, and three public scan starts per IP per UTC day. This authorises short-lived keyed IP quota metadata and hashed operator sessions, but no scan-content storage. Active AI is off: show zero app AI tokens/cost, not fabricated vendor billing. See `scripts/operator-dashboard.md`.

**Hosting and abuse direction:** the owner confirmed `app.123reputationmanagement.org` and plans Cloudflare hosting. Prepare hosted Turnstile, short-term request/cooldown/concurrency controls and contact-spam limits while retaining browser-owned records and unlimited daily operator scans. Loopback development skips only the external challenge. See `deploy/cloudflare/README.md`; actual cloud provisioning, staff Access/MFA, search-service migration and hosted acceptance remain pending. Do not treat a deployment template or dry-run as a live deployment.

## 1. Retained product scope

**Owner:** whoever hosts this copy. The toolkit remains free and open source.

- Individual self-search/parent-guardian workflow and authorised business reputation workflow.
- Up to ten prioritised links in full; additional links have a count/source-domain preview and require contacting the team for follow-up. No automatic unlock after submission. Full records remain browser-owned, so this presentation gate is not an access-control boundary. Same-name review and manual tracking remain available.
- Company/representative wording, business-specific matching and template eligibility. Public company contact details alone are not personal-information exposure. Business authority does not cover another person's private case.
- Country/region preference defaults blank; canonical codes/names, United Kingdom `uk`/`gb` compatibility, English search language and jurisdiction-labelled support resources.
- Factual editable templates; users review accuracy, choose a channel and send themselves. No automatic outreach or verified-removal/legal-representation claims.
- Adult known-URL intimate-content organiser; no imagery discovery. Under-18-at-creation/uncertain-age intake receives help without case persistence.
- Manual submission dates/references, immutable 14-day reminders, initial/follow-up draft edits and terminal outcomes. No background sender or notifications.
- Designer-supplied 123 Reputation Management shield, local font, corporate footer and five-page theme. See [BRAND.md](BRAND.md). The confirmed hostname is `app.123reputationmanagement.org`; the owner plans Cloudflare hosting. See `deploy/cloudflare/README.md` for application, search-service and abuse-control preparation.

No billing, public accounts, shared case access, perpetrator identification, media uploads or automatic submissions are included. Operator access uses a private shared access key and revocable sessions for this MVP; it does not add shared case storage. The app does not verify identity, authority, allegations or legal eligibility.

## 2. Active architecture

| Component | Responsibility |
| --- | --- |
| `src/browser-store.js` | IndexedDB, transaction-commit semantics, atomic synchronous updates, visible failure with no server fallback |
| `src/browser-api.js` | Local service bridge; network allowlist for config, enabled search and explicit assistance |
| `src/browser-scans.js` | Local intake/planning/progress, filtering, heuristic classification, reports/drafts, session imports and deletion |
| `src/browser-takedowns.js` | Local case validation/channels/drafts, saved edits, state transitions and reminders |
| `src/private-worker.js` | Active Worker: config, gated minimal relay, explicit assistance, retired-route responses |
| `src/public-abuse.js` | Hosted bot validation, keyed short-term throttles and expiring query-free concurrency leases |
| `scripts/build-browser.mjs` | esbuild entry `src/browser-api.js` → generated `public/local-api.js`; no secrets or runtime CDN |
| `text`, `queries`, `rank`, `lexicon`, `templates`, `platforms`, `countries` | Shared deterministic logic and bundled data |
| `classify`, `serp`, `takedowns` | Reused local classifier, mock/provider adapters and pure case helpers; legacy network/storage exports remain outside browser execution |
| `public/*` | Five pages, local record list/deletion, editable drafts, attachment preview and explicit user actions |

`localApi` resolves API-shaped record operations in the browser. Fragment IDs identify records only in the same origin/profile. Unknown operations, unavailable IndexedDB and missing records fail closed. Atomic updates preserve concurrent edits and cannot recreate deleted records after delayed search/autosave responses.

The active Worker never imports `src/index.js`. Historical `index`, `pipeline`, `draft`, `budget`, `abuse`, `fetchText`, `llm` modules and their tests remain references. Do not reactivate them or restore D1 record endpoints to work around browser issues.

## 3. Network and persistence contract

The browser's only application network routes are:

| Route | Boundary |
| --- | --- |
| `GET /api/config` | Browser-storage mode, provider, relay availability and limits; no records |
| `POST /api/search-session` | Content-free opaque permit; atomic three-start public IP allowance, new-start cooldown and hosted bot check; authenticated operators bypass daily quotas; idempotent retry nonce distinct from browser record ID |
| `POST /api/search` | Exact relay flag plus external provider; strict query/country/kind/permit payload, bounded non-intimate query, same-origin and permit checks, sanitized text results/suggestions |
| `/api/operator/*` | Login, session, logout and authenticated aggregate usage only; never scan contents |
| `POST /api/assistance` | Explicit `consent:true`; bounded contact fields and spam controls; attachment only with separate `share_report:true` and preview |
| `POST /api/draft-ai` | Off unless `AI_DRAFTING_ENABLED=true` and `AI_API_KEY` set. Per-draft `consent:true`; one result's title/link/snippet/platform/request type/facts only; scan permit or Turnstile; per-IP daily cap and global daily USD budget; prompt built server-side; nothing stored but counters (`src/ai-draft.js`) |

The hosted browser can additionally load the official `challenges.cloudflare.com` Turnstile script/frame when a public challenge is required. No query, identity or case IDs are supplied as widget data; the widget still processes browser/IP signals through Cloudflare. Siteverify is a fixed server-only request containing its secret and opaque response token. Tokens are transient and are not persisted with records or quota metadata.

Help links resolve locally; the Worker also retains static help-links compatibility. Direct historical scan/hit/case/import/help/unlock storage requests return 410. No assistance-read endpoint is exposed.

The active server writes only content-free operational metadata and explicitly submitted assistance:

- Anonymous aggregate usage: date, provider, mode, scan starts, attempted search counts/outcomes and estimated costs; never query/result content.
- Short-lived quota metadata: day-scoped keyed IP digest, hashed opaque permit and counters/expiry. Raw IPs and browser record IDs are not stored.
- Short-lived keyed abuse buckets and random concurrency leases contain only scope/counts/expiry, not query or case content. Cleanup of active D1 tables does not override Cloudflare backup retention.
- Operator access metadata: hashed revocable session token/expiry and short-lived keyed login throttles. Hourly scheduled and opportunistic cleanup remove expired metadata.
- `assistance_requests`: explicitly submitted name/email/message/help type, consent version and optional reviewed attachment. Attachments contain subject name/type, country and at most ten URL/title pairs, not snippets, drafts, queues or complete scans.

No server payload caches/logs, cloud AI, page fetches or hosting-contact lookups. `observability.enabled` is false; client/API responses use no-store/no-referrer. Do not claim third-party infrastructure is log-free.

Local deletion does not withdraw assistance, clear provider retention or remove websites. Historical D1 retention is a separate decision. Do not inspect, export, migrate or purge those records during routine development.

## 4. Local development

Use Node 22.23+.

```sh
npm install
npm test -- --no-cache
npm run build:browser
npm run dev:live
```

`dev:live` loads the existing private `.env`, retains its provider/key type, rebuilds the browser bundle and initializes schema. Local SearXNG search requires the dedicated service and SSH tunnel; public relay defaults remain off. Do not replace secret files or expose keys in source, tests, logs or build inputs. No cloud-AI path is active even if keys exist.

Use `npm run dev:demo` only for deliberate fictional testing. Worker state is isolated; browser records additionally need a separate profile/origin for isolation. Never use fixture results for complaints or present them as live findings.

Session imports are browser-service operations, not HTTP uploads. No public import control is supplied. [scripts/session-run.md](scripts/session-run.md) documents a synthetic developer workflow without extracting existing user records.

## 5. Regression coverage

- Name boundaries/two-character names, business matching, country validation, query caps/deduplication, ranking and template eligibility.
- IndexedDB cross-connection persistence, commit versus request-success semantics, quota/abort rollback, concurrent updates, missing-record protection, clear/delete and no network fallback (`fake-indexeddb`).
- Browser scan progress, country/provider handling, session imports, snippet-only classification, same-name handling, consent and no source/AI/RDAP fetches.
- Case authority/age checks, exact URL preservation, no media/network, immutable dates, state races, draft reload and delete-versus-autosave.
- Active Worker with real SQLite: retired routes never access D1; disabled relay never parses/fetches/writes; strict boundaries; anonymous atomic caps; failures counted; explicit contact/attachment consent.
- Browser bridge network allowlist and failed-storage behavior; unknown routes never fall through to fetch.
- Generated bundle contains no credentials, server handler or active cloud network path.

Run `npm test -- --no-cache` and `npm run build:browser`. Public link checks are separate from offline tests. Use current smoke instructions in `VALIDATION.md`; historical curl/D1 scan workflows are retired.

## 6. Acceptance and follow-on work

1. Local browser checks completed for synthetic scans/queues, edited draft reload, saved-record list and unchecked contact previews. IndexedDB and local smoke tests cover reminder timing and deletion. Repeat hosted acceptance before launch; see VALIDATION.md.
2. The SearXNG processing decision is authorised for the local MVP. Preserve visitor consent and obtain authorization before testing real people's names. Public deployment still needs a protected HTTPS gateway, reviewed logging and abuse controls.
3. Verify selected-provider pricing and abuse controls. Daily cost is a configured estimate, not an invoice or a no-surprise-bills guarantee. No LLM cost or server SERP cache belongs to this architecture.
4. Establish assistance handling/retention and a separate historical-D1 retention/deletion process. Local deletion must not claim to erase shared information.
5. After authorization, run a labelled self-search evaluation. The earlier 80% precision target for severity 4–5 results remains unverified; fixtures do not measure it.
6. Prepare Cloudflare hosting at `app.123reputationmanagement.org`, then validate actual deployment, headers, secrets, logging and abuse controls. Turnstile validation and local throttles are implemented and tested locally; hosted keys, edge policies, staff MFA/Access integration and search-service migration require hosted acceptance. Local tests are not evidence of public deployment.

Weekly alerts, sync, accounts, background jobs and exports are future decisions requiring fresh privacy design.
