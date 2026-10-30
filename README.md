# Reputation Scanner — 123 Reputation Management

## Opt-in AI drafting — 4 October 2026

Reports and the known-URL queue can offer **Draft with AI** next to the template draft, only when the server reports `ai_drafting_enabled: true` (`AI_DRAFTING_ENABLED`, off by default, plus the `AI_API_KEY` secret). Each draft needs fresh consent; only that one result's title, link, snippet, platform, request type and typed facts (max 2,000 characters) go to `POST /api/draft-ai` and on to the provider (default OpenAI, `gpt-5-mini`). The Worker builds the prompt server-side with the user fields in a delimited untrusted-data block, caps drafts per network per day (`AI_DRAFTS_PER_IP_DAY`, 10) and estimated daily spend (`AI_DAILY_USD_LIMIT`, USD 5), and fails closed to the templates. Prompts and drafts are never stored or logged; the draft is saved only in the browser. The legacy `CLOUD_AI_ENABLED` stays false. See [PUBLIC-REPO.md](PUBLIC-REPO.md#ai-drafting-opt-in) and the setup section in [deploy/cloudflare/README.md](deploy/cloudflare/README.md).

## Pre-launch changes — 4 October 2026

The free tool is named **Reputation Scanner**. Reports show the top **20** results (`SHOW_LIMIT`, maximum 20); anything beyond stays behind **Contact us to uncover more**. Contact and assistance requests, including links the user types in (for example private Telegram groups), are emailed to the team through Cloudflare's `send_email` binding; D1 then keeps only a content-free receipt, or the full request only if delivery fails (purged after 30 days). The public "Operator sign in" link is removed; protect `/admin*` and `/api/operator/*` with Cloudflare Access and MFA. See [PUBLIC-REPO.md](PUBLIC-REPO.md) and the launch checklist in [deploy/cloudflare/README.md](deploy/cloudflare/README.md).

## Automatic reporting routes — 28 September 2026

Reporting requests now select curated platform emails/forms and use a hostname-only public DNS/RDAP fallback for unlisted domains, including adult platforms in the known-URL queue. Network, CDN and registrar contacts are labelled as escalation routes rather than assumed origin hosts. Unknown contacts are flagged for investigation. This supersedes older statements that the interface never performs DNS/RDAP lookups. See [REPORTING-COVERAGE.md](REPORTING-COVERAGE.md) for current boundaries, privacy disclosure, supported paths and validation.

## Optional connected email — 28 September 2026

The report offers Gmail and Outlook authorization and explicit review-before-send. Provider credentials are required; see [EMAIL-CONNECTION-SETUP.md](EMAIL-CONNECTION-SETUP.md). Only confirmed messages are shared for sending. Optional automatic follow-ups use encrypted offline credentials and approved content for up to 30 days. Editable case records remain browser-owned, and no inbox reading is requested. The Case dashboard provides branded police, law-firm and redacted PR report exports. See [FOLLOWUPS-AND-REPORTS.md](FOLLOWUPS-AND-REPORTS.md). Provider acceptance is not proof of delivery or removal.

## Windows live preview — 27 September 2026

The app at `http://127.0.0.1:8788` now uses the owner's HTTPS SearXNG gateway with a server-only `X-Proxy-Key`. No SSH tunnel or local SearXNG installation is needed. Restart with `npm run dev:live`; it verifies a neutral live search before enabling the relay. Credentials are in the ignored `.env`. Current engine: Google CSE; cloud AI remains off. Existing demo reports remain fictional—start a new scan for live results. Older handoff sections below describe the previous machine/tunnel setup.

A free reputation toolkit for individuals and authorised business representatives. It organises mentions, prepares editable removal requests and tracks known-URL reports. Users review and send every removal request themselves.

## Current handoff — 25 September 2026

**Scans, results, drafts, known-URL cases and reminders now live in the browser's IndexedDB.** The active Worker is `src/private-worker.js`. Previous server-backed scan/case APIs return HTTP 410 and cannot load or change historical records.

**SearXNG integration is authorised for the local MVP.** It uses a dedicated private instance on the existing VPS, reached locally through an SSH tunnel. The public deployment default remains `ALLOW_SEARCH_RELAY=false`; local activation requires a verified service and explicit visitor consent. The active workflow has no cloud AI, source-page fetching, media fetching or DNS/RDAP contact lookup.

This handoff supersedes earlier D1 scan-storage, AI-drafting and server-import instructions. See [PLAN.md](PLAN.md) for boundaries and [VALIDATION.md](VALIDATION.md) for current evidence. The replacement architecture is not yet claimed as verified on a public host.

## Operator dashboard and public allowance

Open `/admin` for the internal usage dashboard. Sign in with `OPERATOR_ACCESS_KEY` from the private `.env`; the key is never included in browser assets or stored by dashboard JavaScript. Signed-in operators can start scans without the public daily quota or daily search-budget cap. Individual scans retain a finite query plan and normal validation/timeouts.

Public visitors receive **three scans per IP per UTC day**, resetting at 00:00 UTC (08:00 Singapore time). A scan contains several search queries; those queries are not counted as separate scans. Retrying an existing, unexpired scan permit does not consume another daily slot. Shared networks share an allowance. The server enforces this with bounded permits and daily-changing keyed IP hashes; cookies, local storage resets and parallel requests cannot create extra slots for the same IP. Changing IPs can change the allowance, so this is not identity verification.

The dashboard tracks aggregate scan starts, search requests, outcomes and estimated search API costs. Cloud AI is disabled, so this app records zero AI tokens and zero AI token cost. The dashboard is not an OpenAI account billing view and does not include the VPS invoice or other projects. See [operator setup and metering](scripts/operator-dashboard.md).

## Cloudflare hosting and abuse protection

The confirmed application hostname is **app.123reputationmanagement.org**. The [Cloudflare deployment guide](deploy/cloudflare/README.md) and example Wrangler configuration prepare Workers Static Assets, D1, Turnstile and a protected search connection. No public deployment or DNS change has been made.

With abuse protection enabled, new public starts have a 60-second cooldown, contact requests have hourly limits, and expiring server leases bound simultaneous search requests. Hosted public scans and assistance require server-verified Turnstile; missing hosted bot settings fail closed. Signed-in operators retain unlimited daily scans, with short-term request controls. The local preview explicitly skips external bot challenges on loopback while retaining the server throttles.

Turnstile adds Cloudflare browser/IP signal processing. It receives no application case identifier or search text in the fields supplied by this app. Challenge tokens are transient, not saved with browser reports. The server keeps only short-lived keyed counters/leases for these controls. D1 backups may retain deleted operational metadata beyond active-table cleanup; this is not a zero-retention guarantee.

SearXNG remains on the dedicated VPS for the current local preview. Moving all compute to Cloudflare Containers requires a separate staging deployment and verification of upstream search responses and cold starts. A protected Cloudflare Tunnel/Access connection to the tested VPS is also supported. Staff MFA/Access provisioning, stricter scan-plan binding, hosted edge rules and production acceptance remain follow-on work.

## Where information goes

| Information | Location and handling |
| --- | --- |
| Names, context, results, drafts, statuses, cases and reminder dates | IndexedDB in this browser profile and site origin; no automatic server copy or device sync |
| Live query | After relay enablement and user opt-in: browser → temporary Worker processing → dedicated SearXNG → configured upstream engines. An explicitly consented SerpApi backup receives the same query when Google supplies no usable listings. Returned text results are saved in the browser. Country context remains local in this workflow. |
| Public allowance and abuse controls | Daily-changing keyed IP hashes, hashed scan permits, short-lived throttles/concurrency leases, expiry and counters; no raw IPs, names, queries, URLs or browser record IDs. Active tables are cleaned automatically; infrastructure backup retention is separate. |
| Usage dashboard | Daily aggregate counts, provider, public/operator mode and estimated cost; no scan contents. |
| Operator access | Hashed session tokens, expiry and short-lived keyed login-throttle identifiers. Login key is checked server-side; session cookie is HttpOnly. |
| Assistance request | Emailed to the team: explicitly submitted name, email, message, help type, up to 20 user-entered links and a separately opted-in, previewed attachment with subject name/type, country and at most 20 selected URL/title pairs. D1 keeps a content-free receipt after delivery, or the full request only if delivery fails; all rows are purged after 30 days |
| Historical D1 records | Preserved and inaccessible through active APIs; not automatically migrated, read or purged |

The browser scan service permits `GET /api/config`, content-free `POST /api/search-session`, gated `POST /api/search`, and explicit `POST /api/assistance`. The separate operator dashboard uses only its authenticated `/api/operator/*` endpoints. Scan/case operations and help links resolve locally. Failed browser storage never falls back to a server. The Worker also serves static help links for compatibility. It does not cache search payloads, log payloads, use analytics or automatically contact reporting platforms. Worker observability is disabled. Hosting and provider infrastructure still process requests; this is not a promise that all third parties keep no metadata.

Browser-only storage does not hide live queries from our server or upstream search engines. [SearXNG forwards query text to configured engines](https://docs.searxng.org/dev/search_api.html); names within queries remain visible to them. Self-hosting controls our logging, not upstream retention. The existing Parallel Search research harness is not imported: its cloud AI, page fetching, Parallel fallback and JSONL/Excel logging are excluded. The optional SerpApi backup requires private server configuration and explicit consent on each new scan; old consent is not broadened automatically. See [SerpApi setup](SERPAPI-SETUP.md). No demo fallback runs in live mode.

## Returning, deleting and sharing

Use **Your saved scans and queues** in the same browser profile and origin. Report/case links use fragment identifiers; sharing a link does not copy its local record to another device. Anyone using that profile may access its records. Clearing site data, private-browsing expiry, browser eviction or changing the site origin can remove access. There is no account recovery or server backup.

Delete one scan/case from its page, or use **Clear all toolkit data**. Deletion does not remove source websites, submitted reports, provider-held data or assistance already sent. The quick-exit button has been removed. Leaving a page does not clear local records, history or the clipboard.

The report shows up to **20 priority links** in full. Additional results show a count and source-domain preview, with **Contact us to uncover more** leading to a prefilled assistance request. Sending it requests follow-up and does not automatically unlock results. Full records remain in IndexedDB: this is a presentation-level contact gate, not a server-enforced entitlement or paywall. The contact form previews any selected attachment and requires consent before sending. It shares at most 20 selected results, never the complete hidden list automatically. The server emails the request to the team (see `deploy/cloudflare/README.md`); it does not contact a partner or expose an assistance-read API. Partner organisations are contacted only with the user's agreement.

## Individual, business and country context

Choose **For myself** for a self-search or parent/guardian search, or **For a business** for an organisation you own or are authorised to represent. Business intake includes company/trading names, location, optional website/industry and a representative. The website is saved as an origin for matching, not crawled. Representative details support correspondence and are not appended to search queries.

Business names are matched without personal-name word swaps. Generic public company addresses/telephone listings alone are not personal-information exposure. Requests name the company and representative. Business mode does not authorise action over an employee's private case. Personal-information and copyright template restrictions still apply. The app does not verify identity, ownership, allegations or removal eligibility.

Both modes use a local country/region dropdown, defaulting to **No country preference**. With SearXNG and its SerpApi backup, country is used only for local identity matching, is omitted from search requests, and is not advertised as a search-region filter. SearXNG autocomplete is disabled. Other supported providers retain their existing country/autocomplete behavior; a blank preference omits the country parameter. Choices derive from [SerpAPI's country list](https://serpapi.com/google-countries), bundled with modern labels, `uk` for the United Kingdom (`gb` accepted as an alias), and obsolete Netherlands Antilles omitted. Country is a preference, not exhaustive global coverage. SearXNG requests all languages; support links retain jurisdiction labels.

Reports initially prioritise 20 mentions. Matching and severity are local rules applied to provider/imported snippets, not verified findings or source-page analysis. Review same-name matches and every draft statement.

## Known-URL adult intimate-content workflow

At `/takedowns`, enter known public URLs, confirm authority/non-consensual sharing and review local requests. Exact content-identifying URL parameters are retained. The app does not discover intimate imagery, open these URLs, preview media, accept images or verify content. Known platforms have reporting guidance; unknown hosts require a reporting route found manually.

Initial/follow-up draft edits are saved locally. Users submit requests themselves, then record the actual sent date and optional reference. The first sent date fixes a reminder exactly 14 days later; duplicate actions cannot postpone it. Closed reports stop reminding. Reminders update while open or on reopening; there is no background sender/notification. Fourteen days is an administrative interval, not a legal deadline.

Under-18-at-creation and uncertain-age cases receive specialist links without saving intake. The general scanner also routes intimate-content/child-safety concerns to help. See [reporting-channel notes](scripts/takedown-channels.md) for sources and eligibility; this handoff governs current storage.

## Build and run locally

Use Node 22.23+; integration tests use `node:sqlite`.

```sh
npm install
npm run build:browser
npm test -- --no-cache
npm run dev:live
```

Ordinary development uses `http://localhost:8787`; live preview uses `http://127.0.0.1:8788`. `dev:live` rebuilds the browser bundle, initializes local schema and loads the existing private `.env`. SearXNG needs either its configured protected HTTPS endpoint or the dedicated SSH tunnel; see [the service guide](deploy/searxng/README.md). `SERPAPI_API_KEY` is used only by the explicitly consented backup. Startup checks report failed primary engines separately and permit degraded coverage only with a responding primary engine and verified backup. Do not replace existing secret files or put keys in browser assets. Cloud-AI keys have no active execution path.

For deliberate fictional testing, use `npm run dev:demo`. It forces mock providers, clears provider keys for that process and isolates Worker state. IndexedDB remains origin/profile-scoped: use a separate profile or port for browser-record isolation. Demo findings must remain labelled fictional and must never support real complaints. Do not silently substitute demo for the owner's configured preview.

`npm run dev` also rebuilds the browser service. `npm run build:browser` uses esbuild to generate `public/local-api.js`; do not edit that bundle. It has no runtime CDN or credential input. Session import has no public upload UI; see the [developer-only guide](scripts/session-run.md).

## Verification and launch work

Run `npm test -- --no-cache` and `npm run build:browser`. Vitest covers pure rules, browser services, IndexedDB transaction semantics through `fake-indexeddb`, and the active Worker using real SQLite. External services are mocked. Tests cover storage failures/rollback, concurrent edits, deletion, consent, relay disablement, anonymous caps and retired routes. Historical server tests remain regression references, not the active runtime.

Use [VALIDATION.md](VALIDATION.md) for current browser/HTTP checks and smoke commands. `npm run check-links` makes public-resource requests and is separate from offline tests. Earlier live-provider/D1-pipeline checks do not validate this replacement architecture.

Before launch: establish a protected HTTPS search connection and validate its logging, explain upstream processing/retention, configure real Turnstile keys and staff access, validate the hosted build in a real browser, review capacity/abuse controls, decide historical-data retention/deletion, establish assistance handling and run a consented labelled precision evaluation. Fixtures do not establish accuracy. The hostname is confirmed as `app.123reputationmanagement.org`; deployment and hosted acceptance remain pending.

## Brand

All five pages retain the designer shield artwork, local Inter Tight font, navy/teal/gold theme and shared corporate footer. Corporate links use absolute main-site URLs; toolkit routes/assets stay same-origin. Preserve support notes, accuracy controls and privacy explanations. See [BRAND.md](BRAND.md) for provenance and design rules.

## Licence

Released under the [GNU Affero General Public License v3.0](LICENSE). If you host a modified copy, you must publish your changes under the same licence, so every deployment stays as checkable as this one.
