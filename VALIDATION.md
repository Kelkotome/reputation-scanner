## 2026-10-04 — Opt-in AI drafting

- Added `POST /api/draft-ai` (`src/ai-draft.js`), off by default (`AI_DRAFTING_ENABLED=false` in both Wrangler configs). Same-origin/JSON checks, per-draft `consent: true`, strict field caps (title 500, link 2,048, snippet 2,000, platform 120, facts 2,000), scan permit or Turnstile (`ai_draft` action), per-IP daily cap (`AI_DRAFTS_PER_IP_DAY`, 10) on the keyed daily IP hash, and an atomic worst-case reservation against `AI_DAILY_USD_LIMIT` (USD 5) settled from reported token usage. Anthropic Messages API by default (`claude-sonnet-5`, `max_tokens` 800, 20 s timeout), with an OpenAI-compatible adapter. Prompts and drafts are not stored or logged; new `ai_draft_usage` table holds daily counters only.
- Browser: "Draft with AI" next to the template draft on reports and the known-URL queue, fresh consent dialog each time, draft saved in IndexedDB and labelled "AI draft — check every detail before sending". `/api/config` adds `ai_drafting_enabled` and `ai_provider_name` only. "No cloud AI is used" copy replaced.
- Validation: `npm test -- --no-cache` and `npm run build:browser` (results in the handoff report). Provider calls are mocked; no real AI API was called and nothing was deployed.

## 2026-10-04 — Pre-launch fixes (Reputation Scanner)

- Renamed the tool **Reputation Scanner** in page titles, navigation, hero and help copy; production Worker `reputation-scanner`; `workers_dev: false` in both configs.
- Visible results raised to 20 (`VISIBLE_RESULT_LIMIT`, `SHOW_LIMIT=20`); results beyond 20 keep the "Contact us to uncover more" flow. Report export now includes `google_backup_consent` and `configured_google_backup_provider`.
- Assistance requests are emailed through the `ASSISTANCE_MAIL` `send_email` binding with a hand-built UTF-8 MIME message (encoded-word headers, base64 body, validated Reply-To). After delivery D1 keeps a content-free receipt; on failure or without the binding the full request is stored. `cleanPrivateMetadata` purges `assistance_requests` older than 30 days. Optional user-entered links (for example private Telegram groups) are accepted.
- Security headers (HSTS, Permissions-Policy, COOP, `X-Robots-Tag`), `robots.txt`, Open Graph tags, privacy/terms/help footer links and the operator line added. Public operator sign-in link removed. IPv6 quota identities bucketed by /64.
- Internal hosts, SSH paths, owner machine paths and personal names redacted for the public repository; `PUBLIC-REPO.md` added.
- Validation: `npm test -- --no-cache` 1086 tests across 44 files passed; `npm run build:browser` succeeded; local `wrangler dev` smoke passed, including a simulated `send_email` delivery and header checks. No deployment, live search or real email.

## 2026-10-01 — Live Google, Bing and CSE upgrade accepted

Verified SSH access to the actual VPS `<your-vps-ip>` using the installed device key. Isolated tests of the official pinned image `2026.9.30-a9d990033` followed explicit user approval. A separately approved live upgrade now uses Google, Bing and Google CSE. The original July image/container and root-only settings backup are retained; the unrelated stock service is unchanged.

The first live attempt omitted the gateway Docker network, passed loopback checks but failed HTTPS with 502, and was rolled back successfully. The accepted retry preserves `bridge` and `<gateway-docker-network>`. It keeps the existing private entrypoint, runtime secret, read-only mounts/filesystem, no logs, no-new-privileges, dropped capabilities, loopback port, memory/CPU/PID limits, disabled media features and bounded tmpfs. Candidate/current settings were parsed privately: runtime secret and every non-engine section were identical. No secret was printed or transferred to this workspace.

Authenticated gateway preflight verified each selected engine separately (Google 10, Bing 10, CSE 20 usable results). Combined gateway probe returned 31 listings attributed to all three. The local app's regular authenticated search route returned HTTP 200 with 31 page-one listings, then 29 page-two listings with 25 new URLs from Google/CSE; no partial status. Only neutral queries were used. A test-only operator session avoided consuming the user's public scan allowance and was closed afterward. Local `/api/config` advertises the three engines and 24 query requests.

Added bounded per-engine neutral startup verification to prevent CSE masking a nonworking selected engine. Provenance requires usable public URLs. UI labels distinguish configured engines and actual responders in a scan; module cache versions updated. Validation: 201 focused tests in four files passed; browser bundle built successfully; real gateway and local route tests passed. Current report UI automation was unavailable because the browser focus command timed out twice; no UI refresh or new personal scan was performed. Existing browser-stored cases remain unchanged.

Limits: standalone Google responses were sometimes empty. Bing deliberately lacks pagination in this SearXNG version. Brave returned no results; DuckDuckGo did not contribute to combined tests, so neither is enabled. Tests do not establish exhaustive search coverage or recovery of the screenshot URLs. Saved scans must be rerun by the user to benefit from the new provider configuration.

Operational record: `deploy/searxng/LIVE-UPGRADE.md`. Rollback container: `reputation-searxng-rollback-20261001T111658Z`. Backup: `/var/lib/123-reputation-searxng/backups/general-web-upgrade-20261001T111658Z`.
## 2026-10-01 — Reputation keyword coverage and personal-result priorities

New scans combine exact/unquoted name searches with news, scams/fraud, scandal, defamation/slander/libel, allegations, rumours, complaints, exposure and private-information/data-leak terms. SearXNG scans request page two of both broad name searches within the existing request allowance. Page numbers are bounded, validated at the server, and counted against quotas. Distinct pages on the same domain are retained; duplicate URLs remain removed.

Personal reports rank flagged mentions first, group ordinary matches in a secondary section, and omit neutral professional/directory matches based on host/title heuristics. The total full-detail preview remains ten links, with additional links previewed by domain. Reports count name matches and automated flags separately. Existing records are rerendered without rerunning a search; old classifications and pages already discarded cannot be recovered without a fresh scan. Provider results can differ from Google, and sensitive content remains outside the general report.

The report links to the adult known-URL removal queue and prefills only the locally stored affected name. Age, authority, URL and contact declarations remain user-entered. No adult page, media, new personal search or email was requested during this verification.

Validation: 704 tests / 36 files passed; after the final private-information term update, 107 focused tests / 5 files passed. Browser bundle and syntax checks passed. Browser QA confirmed a saved report shows two flagged mentions before ordinary matches, excludes five professional/directory matches, and preserves ten visible links plus five additional previews. The known-URL handoff prefills the name and leaves age/consent/contact/URL fields unsubmitted. Screenshot: `artifacts/scan-focus.png`.

Live pagination was verified with the neutral technical query `example.com`: the private SearXNG provider returned twenty text results on each of pages one and two, including eighteen new URLs on page two, without partial-engine status. Only aggregate counts were printed. This does not verify coverage for the user's missing Google results.

## 2026-09-28 — Optional Gmail / Outlook sending

Added provider authorization with browser-bound one-use state, PKCE, pinned origin, encrypted short-lived server credentials, and send-only mail access plus account identity. Added explicit sender/recipient/message review, placeholder validation, session-bound duplicate protection, sending limits, disconnect, and provider acceptance tracking in the local report. No refresh tokens, inbox reading, or automatic follow-ups. Added additive local D1 tables and private setup helper; provider credentials remain unconfigured.

Validation: all 646 tests in 31 files passed, including 12 new email tests with simulated provider responses. JavaScript syntax checks passed. Applied schema to local live-state database. Browser QA on fictional Alex Example report verified Gmail/Outlook remain disabled until configured, draft preview stays enabled, and direct sending stays disabled. Local email status returned both providers unavailable with no account. No live OAuth login or email was performed; end-to-end provider verification requires credentials. Setup instructions: EMAIL-CONNECTION-SETUP.md.

## 2026-09-27 — More report request types

Added general removal, platform policy review, personal identifying-detail redaction, targeted harassment reporting, and follow-up drafts. Relevant result categories receive general alternatives; harassment is category-specific, personal redaction is excluded for businesses, and follow-up is available for sent, refused or escalated requests. Existing sensitive-content and copyright eligibility checks remain enforced. Blank-email previews remain supported.

Validation: browser bundle rebuilt; all 633 tests across 30 files passed. Added coverage for new eligibility, business signatures, editable placeholders and draft length. No live user search or email was sent.

# Validation — 25 September 2026

## Email-free draft preview — 27 September 2026

- Contact email is optional for previewing/editing a report draft. An explicitly blank email produces `[Your contact email]`, even if the scan or another saved draft contains an address. Nonempty invalid addresses remain rejected. Sending/copy/mark-sent controls still require an email and accuracy confirmation.
- Browser bundle and syntax checks pass; 59 focused browser-scan/template tests pass. Fresh-tab walkthrough with the existing fictional demo report confirmed the editable preview, placeholder and disabled sending actions. User's active report was not reloaded or changed; no search, email or contact submission occurred.

## Consent clarity — 27 September 2026

- Sensitive-content selections route to specialist support without searches. The intake now hides the unnecessary disabled search-consent checkbox and shows an explicit explanation in that mode.
- Fresh browser-tab verification: consent is checkable in general-search mode; selecting intimate-content support hides it and displays the explanation; returning to general-search mode restores the enabled control. No form submitted or search sent. Existing user form selections were not changed. JavaScript syntax check passed.

## Live HTTPS SearXNG connected — 27 September 2026 (Windows copy)

- User supplied an HTTPS gateway and proxy credential. Added server-only `SEARXNG_PROXY_KEY` / `X-Proxy-Key` support, with validation, HTTPS enforcement and no redirect following. Actual credentials exist only in the ignored `.env`.
- Neutral `example.com` preflight returned 20 results. Replaced the demo process with `npm run dev:live` at `http://127.0.0.1:8788`, using isolated `.wrangler/live-state` operational metadata. The actual Worker → gateway → SearXNG relay also returned 20 results with no partial flag.
- Verification used a temporary operator session, then revoked it. Public scan allowance was preserved; the dashboard has one operator verification scan start, without a browser report. No personal search, email, assistance submission or public deployment occurred.
- Config: `demo:false`, `provider:searxng`, `search_relay_enabled:true`, `cloud_ai_enabled:false`. Credential absent from public config and browser bundle. Refreshed browser shows no demo banner, visible unchecked live-query consent and disabled Start until consent.
- **632 tests pass across 30 files**, including proxy headers, malformed keys, no credential exposure in request URLs/bodies/results and rejection of HTTP proxy-key transport. Browser bundle and HTTP smoke pass.
- Configured engine remains `google cse`; SafeSearch off is requested, not a guarantee of upstream behavior or complete coverage. Existing demo reports remain labelled fictional. No SSH tunnel or local SearXNG install is needed for this gateway.

## Live-start preparation — 27 September 2026 (connection blocked)

- Added `npm run check:live` and a guarded `npm run dev:live` for Windows/local port 8788. The live launcher verifies neutral SearXNG results before building, initializing a separate live database and enabling the local relay. Empty/partial/error responses stop startup; there is no mock fallback.
- Prepared a git-ignored local `.env` with distinct generated quota/operator secrets without displaying them. Provider is SearXNG; relay remains disabled in the file and is enabled by the launcher only after verification.
- Adapter now requests SafeSearch off (`safesearch=0`); the dedicated SearXNG template also defaults off. Existing VPS runtime settings have not been changed or verified. App specialist-content restrictions remain unchanged.
- Actual live preflight failed: no dedicated SearXNG listener at `127.0.0.1:8890`. The handoff's SSH key is on the original Mac and is absent from the Windows locations checked. A local key path or authenticated endpoint is needed to connect. The running port-8788 app remains explicitly demo mode; live searches are not claimed.
- Full regression run: 624 passed, one existing Worker assertion expected the former strict SafeSearch value. Updated that expectation and reran both affected provider/Worker suites: all 161 tests pass. Startup script syntax and its actual fail-closed connection check pass. No personal query, public deployment or message was sent.

## Ten-link contact preview and draft email — 27 September 2026 (Windows copy)

- Reports retain up to ten full priority links, now showing each full URL under its title. Additional links render grey source-domain previews with no full URLs, titles or snippets in the preview DOM. The contact CTA opens a prefilled follow-up request, with no automatic unlock or submission.
- Draft preparation now asks for a valid user contact email, includes it in generated correspondence, and retains existing accuracy review gates. Email account selection and sending happen in the user's email app. A request being sent is separate from content being removed.
- `npm test -- --no-cache`: **625 tests pass across 30 files**. New regressions cover preview redaction/unsafe URLs and validated local sender email, preserving edited drafts for the same email. Browser bundle and JavaScript syntax checks pass.
- Isolated Worker/D1 demo at `http://127.0.0.1:8788`: read-only HTTP smoke passes. Browser walkthrough completed a fictional Alex Example scan, showing ten full URLs and ten extra links in non-clickable previews, generated a draft with a test email and review-gated actions, and verified the prefilled contact form with sharing unchecked. No contact form, email or external report was submitted. The fictional report remains for local review.
- Grey preview styling inspected at the browser's narrow viewport; a 390px layout measurement showed no horizontal overflow. Temporary viewport override reset. No captured browser warnings/errors. Wide desktop layout was not separately revalidated in this pass.
- `EMAIL-TEMPLATES.md` contains five proposed email templates for review; this does not claim all existing template wording was replaced.
- This is a presentation-level contact gate: full records still belong to the browser and can be inspected through developer tools. It is not server-enforced access control. The team does not automatically receive hidden results, and operator assistance review/delivery still needs an operational workflow before public launch.
- Live search remains disabled in this preview. SafeSearch/engine benchmarking and Cloudflare deployment have not been performed in this pass.

## Top-three search engine evaluation — 25 September 2026

- Target set: Google, Bing and Yahoo, the top three in Statcounter's August 2026 worldwide figures. These map to SearXNG `google cse,bing,yahoo` and already pass the adapter's three-engine allowlist configuration.
- Started a separate temporary container from the pinned existing VPS image, with the same privacy controls and a loopback-only test port. Its config reported exactly those three enabled general-web engines.
- Neutral single-engine checks: Google CSE returned 20 results for `example.com`; Bing returned 10 for `wikipedia` and zero for `example.com` and `OpenStreetMap`; Yahoo returned zero for each of those three queries. No real person's name was searched. No result URLs, page bodies or private query contents were saved to project files.
- One combined `example.com` request returned 20 results, all attributed to Google CSE. Bing/Yahoo empty responses reported no `unresponsive_engines`, so configuration success and HTTP success do not establish working three-engine coverage.
- Removed the temporary test container/configuration. Live `reputation-searxng`, other VPS services, the local `.env` and the original app preview remain unchanged. No production rollout or Cloudflare deployment occurred.
- Additional engines remain pending compatibility/availability investigation and neutral runtime acceptance. This documentation-only update does not change application code or prior test results; the full test suite was not rerun.

## Cloudflare preparation and public abuse controls — 25 September 2026

The owner confirmed **app.123reputationmanagement.org** and plans Cloudflare hosting. This section records local implementation and preparation, not a public deployment.

- Added a production Wrangler example with the confirmed Custom Domain, disabled workers.dev/preview URLs, explicit observability off, placeholder production D1 binding and hosted Turnstile protection. A build-only dry-run succeeds. No DNS, Access policy, production database, container or other cloud resource was created.
- Implemented fixed-endpoint server-side Turnstile verification with exact hostname/action checks, bounded response bytes, five-second timeout, redirect rejection and sanitized failures. Hosted public starts/assistance fail closed when bot setup is missing. Only explicit loopback development permits disabling the external challenge. No real challenge was solved or Siteverify call made during validation.
- Added atomic public new-start cooldowns, short-term request throttles, three assistance attempts per IP/hour, and expiring query-free search leases: six globally, two per public caller and four per operator session. Operator starts remain unlimited per day, with a 30-new-starts/minute burst limit. Valid permit retries are idempotent and bypass repeat challenges/new-start charges.
- Added an on-demand challenge dialog with cancel/retry and fixed action/sitekey parameters. Tokens are transient and never stored in reports. A scan keeps its local lease while waiting for the user and rechecks ownership/deletion before minting a permit. Privacy text acknowledges Cloudflare IP/browser-signal processing; no script-isolation promise is made.
- Independent review found and fixed invalid tickets occupying provider capacity before validation. The final relay validates ticket ownership/expiry before acquiring a lease, then revalidates and reserves query allowance afterward. Busy relay attempts consume no request/cost allowance. Another integration check found public three-query browser batches conflicting with the two-request server cap; protected public scans now batch two, with operator/legacy behavior preserved.
- Added server-only paired Cloudflare Access service-token headers for the fixed HTTPS SearXNG endpoint, retaining bearer and explicit loopback support. Partial/malformed/unsafe credentials fail before fetch. No real service token was used; the tested local SearXNG route remains the VPS SSH tunnel.
- **621 tests pass across 29 files**, including mocked challenge success/failure/expiry/replay responses, hostname/action/config failures, burst/cooldown/contact limits, concurrency/expiry/release, invalid-ticket isolation, browser challenge cancellation and token non-persistence, complete public/operator query progress, and Access header safety. Browser bundle and syntax checks pass.
- Isolated Worker/D1 preview on port 8788 verified a public permit/retry, immediate cooldown rejection, invalid-ticket rejection, three synthetic assistance records with the fourth blocked, four operator starts and accurate aggregates. One neutral `example.com` query returned 20 results through the actual VPS service. This used only the temporary database; no real person's name or assistance request was submitted.
- Switched only that isolated preview to a loopback empty-result fixture, then completed a fictional public browser scan: **12 / 12 queries**, no self-throttling, no browser warnings/errors. The fixture name never reached an external search engine. Its browser record is confined to the test origin; no test record was added at port 8787.
- Applied the additive schema and restarted the real preview at `http://localhost:8787`. Verified abuse controls enabled, local external challenge disabled, three daily public scans, 60-second cooldown, SearXNG relay enabled, cloud AI off, protected operator usage and revocable login. Both actual scan-start counters remain zero. `npm run smoke:local` passes without scans or submissions.

See `deploy/cloudflare/README.md` for setup and primary references. Real Turnstile keys, hosted bot verification, staff Access/MFA integration, edge rate rules, production D1/gateway and public-host acceptance remain pending. Moving SearXNG into Cloudflare Containers also requires a separate image/network/cold-start validation. D1 active-table cleanup does not erase Time Travel backups immediately. No complete anti-abuse, identity-verification or zero-retention guarantee is claimed.

## Operator dashboard and public scan allowance — 25 September 2026

This section supersedes earlier descriptions of unmetered or cookie-free active searches. The owner requested an internal usage dashboard, unlimited daily operator scans and a public allowance of three scans per IP per day.

- Added `/admin` with authenticated access, today's and 30 days' totals, public/operator breakdown, query outcomes and estimated API cost. AI input/output tokens and cost remain zero because this app has no active cloud-AI path. Estimates are not provider invoices and exclude VPS hosting and other apps.
- Public scans require a server-issued permit. A daily-changing HMAC of the trusted client IP enforces three starts per UTC day; raw IPs, names, query text, results and browser record IDs are not stored. Both audiences have bounded permits. Authenticated operators bypass the public daily scan, search-request and spend caps, while retaining a 60-query per-scan workload and provider safeguards.
- Added key-based operator sign-in, eight-hour HttpOnly/SameSite=Strict sessions, secure production cookies, logout revocation, key-rotation invalidation and throttled sign-in attempts. Local HTTP access requires the explicit loopback development flag. Secrets were generated in `.env` without exposing them in task output.
- Scan starts and their aggregate counters commit atomically through a database trigger. Tests cover an aborted counter write, a committed write followed by a lost response, duplicate/concurrent starts, the fourth public start, permit expiry and request ceilings. Browser tests cover permit persistence, renewal, fresh authentication checks and sign-out during unfinished operator work.
- **547 tests pass across 27 files** with outbound services mocked. Browser bundle, JavaScript syntax and Wrangler build-only deployment check pass. A dashboard DOM harness checks key clearing, auth failures, period totals, untrusted provider text, late responses after sign-out and sign-out error recovery.
- Isolated actual Worker/D1 preview on port 8788: three public permits succeeded, the fourth was rejected, duplicate retries preserved the permit/count, and authenticated operators passed beyond three starts and bypassed a deliberately zero public budget. One neutral `example.com` request returned 20 results through SearXNG and incremented operator request/success counters. Applying the final trigger and retrying the same new operator start recorded exactly one additional scan.
- Browser walkthrough on that isolated origin confirmed sign-in, counters matching the HTTP checks, today/30-day switching, operator search mode and sign-out returning to the locked dashboard. Desktop layout inspected. No user case or personal search was created, and no assistance/removal request was submitted.
- Applied the additive schema and restarted the real preview at `http://localhost:8787`. Verified public configuration, protected dashboard and no-store/noindex page headers; authenticated with the saved key in memory, read usage, then revoked the session. Both real-origin scan-start counters remain zero: the user's public allowance was not consumed. Existing browser records and historical server content were not read or migrated.
- `npm run smoke:local` passes against the restarted preview. The local server and SearXNG tunnel remain running. Hourly scheduled/request-time metadata cleanup is configured; the application itself has not been publicly deployed.

Access/setup details: `scripts/operator-dashboard.md`. Retention is limited to short-lived quota/session metadata and 30 days of aggregate counters. Saved scan/case content remains browser-owned; explicit assistance submissions retain their separate consent boundary. IP quotas are shared by users on one network and do not prevent someone changing IP addresses. Hosted enforcement still requires the trusted Cloudflare edge and deployment secrets.

## Dedicated SearXNG integration — 25 September 2026

This section supersedes earlier statements that live search is awaiting the owner's processing decision. The owner authorised this integration after review of the server/upstream privacy boundary.

- Added a fixed-endpoint, server-only SearXNG adapter. POST requests carry only a bounded query, selected engine, English language, SafeSearch and JSON format. No country, email, scan ID, draft, source-page fetch, AI request, provider fallback or autocomplete is sent. Responses are bounded to 512 KiB and 20 sanitized URL/title/snippet records. Engine failures cannot appear as a clean completed search; partial results remain reviewable with an incomplete notice and retry.
- Deployed `reputation-searxng` as a separate VPS container from the existing research service. Pinned the locally installed image `2026.7.12+c19d86faa` by image ID. Runtime `/config` confirms only `google cse` is loaded; `keep_only` removes all other engines. No existing container, proxy, DNS or shared research configuration was changed.
- Runtime Docker configuration confirms loopback-only `127.0.0.1:8890`, a read-only root filesystem, 512 MiB memory/no extra swap, empty log path and logging driver `none`. Granian access/application logs and Python logging are disabled; launcher output is discarded. The Python logging override was checked in-container. Only settings/secret persist; cache/temp mounts are memory-backed. These controls do not establish an upstream or VPS-provider zero-retention agreement.
- Local SSH tunnel connects `127.0.0.1:8890` to that private VPS service. The saved `.env` selects SearXNG, enables this local relay and caps scans at 12 queries with 300 daily relay requests. Other credentials are preserved and unused. Cloud AI remains off. The public Wrangler configuration still defaults to relay disabled.
- Neutral `example.com` checks returned HTTP 200 and 20 results through both the dedicated service and the complete localhost Worker → tunnel → VPS path, with no failed engines/partial flag. No person's name, real case, assistance request or removal request was submitted. This verifies connectivity and response mapping, not reputation-match precision or comprehensive coverage.
- Live Worker verification exposed that workerd rejects `redirect:error`. The adapter and relay now use `manual` and reject/cancel all 3xx responses without following or exposing Location. Regression tests ensure a redirect cannot forward queries or credentials to another destination.
- **507 tests pass across 26 files**, including provider boundaries, disabled autocomplete, country retained locally, partial results/retries, failed-call accounting and redirect handling. Browser bundle and Worker dry-run build pass. Local HTTP smoke verifies five pages, the browser bundle, no-store retired APIs and no server record access.
- Browser preview at `http://localhost:8787/` visibly confirms SearXNG availability, local-only country matching, upstream-processing consent unchecked, Start disabled before consent, no demo banner and no existing browser records. No test records were added to this origin.

The local server and SSH tunnel must remain running. Restart instructions are in `deploy/searxng/README.md`. Public-subdomain deployment, an authenticated HTTPS gateway, hosted abuse controls, user-approved real-name precision evaluation and assistance handling/retention remain follow-on work.

## Browser-owned storage and explicit sharing (previous phase)

This section supersedes the historical server-storage validation below.

- Installed active `src/private-worker.js` and browser service bundle in the original Reputation Management project. `npm install --ignore-scripts --no-audit --no-fund` completed; `npm run build:browser` succeeded. **452 tests pass across 25 files** with outbound services mocked. Tests include 191 new checks for IndexedDB, browser services/bridge and the active Worker; 261 historical module checks remain as regression references.
- Browser storage tests use `fake-indexeddb` with real IndexedDB transaction behavior: request success followed by abort, quota failures, mutator rollback, cross-connection reloads, concurrent updates and clear/delete. No server fallback exists. Delayed scans and draft autosaves cannot recreate deleted records.
- New Worker tests use SQLite for anonymous budget reservations and explicit assistance persistence. Retired scan/hit/case/import/help/unlock routes return 410 before body/DB access. Disabled relay rejects before parsing or provider/DB operations. Only opted-in assistance can persist user content, with separate attachment consent and strict field limits.
- Bridge tests prove local case work, storage failures, support links and attachment previews make no network calls. Hidden top-level/nested attachment fields are rejected before transmission. Cookies/referrers are omitted on the three permitted network routes.
- CSP `form-action 'none'` blocks native form navigation if JavaScript fails; contact and case submit buttons start disabled until handlers are attached. Regression coverage protects this fallback. Quick exit is removed from all five pages and its layout reservation removed.
- Browser bundle inspection found no cloud/provider network endpoints or server storage handlers. Its only fetch boundary is the explicit config/search/assistance allowlist. No cloud AI, source-page/media fetching, DNS/RDAP, analytics or server search cache remains on the active path. Observability is disabled.
- Wrangler dry-run passed with the new entry point; no deployment occurred. New schema only adds empty `private_usage_daily` and `assistance_requests` tables. Historical records and secret files were preserved, not inspected, migrated or purged.

### Actual local runtime and browser checks

- Restarted the installed app at `http://localhost:8787`. `/api/config` reports `storage: browser`, `demo: false`, `provider: serpapi`, `cloud_ai_enabled: false`, `search_relay_enabled: false`. A disabled search request returned 403. No live provider call was made.
- `npm run smoke:local` passed against the installed server: five pages/bundle served, retired routes return 410/no-store. `node scripts/smoke-takedowns.mjs` passed with isolated IndexedDB: synthetic case, edited draft reload, overdue 14-day reminder and deletion. No network call or report submission.
- Isolated mock preview on port 8790: a synthetic individual scan completed with fictional results. Generated a local template, edited it, reloaded, and confirmed the edit persisted. Reporting actions were disabled pending accuracy review.
- Selected-result assistance link opened a local preview with the correct subject and one URL/title. Both attachment sharing and contact consent were unchecked; nothing was submitted.
- Created a synthetic known-URL case with known-platform and unknown-host routes. URLs rendered as text, no source preview. Edited its request, reloaded and confirmed persistence. Home listed both saved synthetic records. Fixtures exist only in the isolated preview origin, not the installed app origin.
- A 390px mobile check showed no horizontal overflow and no quick-exit button. No captured browser console warnings/errors. Temporary viewport override reset.
- Original source backups are in `name-scanner-before-browser-storage-pcakae3z` under the macOS temporary-items directory. No secret files were copied into that backup.

### Limits and pending decisions

The SearXNG decision and local verification above supersede the earlier paused-search state. No SerpAPI ZeroTrace feature or upstream zero-retention agreement is enabled or verified. No claim of a live precision evaluation, public hosting, provider-side zero retention or automatic assistance handling is made. Historical D1 content remains preserved but inaccessible through the active API. Browser storage is tied to this profile and origin; clearing site data can remove it.

---

## Historical validation (earlier architecture)

# Validation — 24 September 2026

Project: Reputation Management / `name-scanner`.

## Shared corporate footer

- Matched the live https://123reputationmanagement.org/ footer inspected on 24 September 2026: navy background, brand description, Services/Industries/Resources/Company columns, copyright and legal links. All 27 footer destination URLs exactly match the live reference.
- Used the supplied white shield/wordmark artwork in a compact horizontal layout, preserving the original local PNG. Corporate links use absolute HTTPS URLs and `noreferrer`; no scan/case identifiers are added. No remote scripts, fonts, analytics or runtime footer fetch was introduced.
- All five HTML pages contain an identical footer, exactly one footer landmark, unchanged unique element IDs and refreshed CSS version. Existing page-specific toolkit notes and local support links remain above it.
- Browser checks passed at 1280px desktop and 390px mobile: five-column desktop grid, brand above two-column mobile links, readable logo and legal links, no horizontal overflow or captured console warnings/errors. Viewport override reset.
- `npm test -- --no-cache`: **261 tests pass across 20 files**. No tests were added for this styling-only change. All five served HTML files and the stylesheet match the verified staging files byte-for-byte.
- `/api/config` continues to report `demo: false`, `cloud_ai_enabled: false`. Backend, keys and existing data were not changed; no live scan, report submission or deployment was performed.

## Country/region dropdown and search geography

- Optional native dropdown for individual and business intake: 242 supported Google-provider countries/regions, alphabetical modern English labels, one UK entry and a blank **No country preference** default. Options are bundled; no runtime list request.
- API validates and canonicalises country codes, accepts recognised legacy names and `gb` as an alias for `uk`, and ignores conflicting client labels. A blank selection is stored as blank. Versioned scan identities include country and provider; old reports remain readable without being reused as country-aware results.
- Search and autocomplete use the saved country preference. Explicit blank overrides a deployment default and omits the geography parameter. Country-aware result caches isolate selected countries, no preference, legacy scans, providers and mock subject types. Query expansion no longer invents Singapore when unselected.
- `npm test -- --no-cache`: **261 passing tests across 20 files**, with mocked outbound services. New coverage includes canonical validation, country-specific and concurrent reuse, minor/business boundaries, legacy report access, emitted search/autocomplete parameters, cache isolation and the static list/UI contract.
- JavaScript syntax checks and Wrangler dry-run passed; no deployment. Original project source was updated after tests, and the existing local Worker reloaded it. `/api/config` still reports `demo: false`, `cloud_ai_enabled: false`.
- Browser checks passed at 1280px desktop and 390px mobile. Selected US in individual mode and UK in business mode, checked optional blank default and mode changes, no horizontal overflow or captured console warnings/errors. Restored the blank individual form and reset the viewport override.
- No live scan, AI request or external report was submitted for this change. Saved secrets, existing scan data and the known-URL reporting workflow were preserved. The selected country is a search preference, not a strict filter or worldwide coverage guarantee. The list targets Google providers; alternate-provider country coverage and global support/legal localisation remain unvalidated.

## Supplied designer logo applied

- Replaced the placeholder in all ten header/footer placements across five pages. Colour shield and original wordmark appear in the header; the supplied white stacked logo appears in the navy footer. The monochrome shield is used for the favicon.
- Both source PNGs from the owner's Logos directory are copied byte-for-byte, with inline SVG viewports selecting artwork from the presentation sheets. No external image service, font service or tracking request was introduced.
- Static checks passed: five pages have two supplied logo placements and one new favicon link, all IDs remain unique, stylesheet and favicon XML parse successfully. Browser checks confirmed the embedded favicon renders.
- Desktop (1280px) and mobile (390px) header/footer presentation checked. No horizontal overflow, logo clipping or captured console errors/warnings. Temporary viewport override reset.
- Only public branding assets/styles/markup and documentation changed. Application JavaScript, API logic, saved credentials and live SerpAPI configuration were not changed. Full backend tests were not rerun for this visual-only update.

## SerpAPI provider corrected

- Owner confirmed the key was issued by serpapi.com. `.env` now selects `SERP_PROVIDER=serpapi`; the saved key was preserved and cloud AI remains disabled.
- One neutral `example.com` search through the actual SerpAPI adapter succeeded: HTTP 200, `search_metadata.status=Success`, nine organic results and no provider JSON error. No personal scan data was sent. This validates credentials and adapter connectivity, not live reputation-match precision.
- New scans use live SerpAPI; existing demo reports retain their fictional data and need a new scan for live results.
- SerpAPI HTTP 200 responses containing a JSON error or Error status now fail safely rather than becoming empty successful results. Successful autocomplete mapping and both error forms have regression coverage. `npm test -- --no-cache`: **223 tests pass across 18 files**.

## Live configuration and provider isolation

- The local listener was switched from `dev:demo` to `dev:live`; `/api/config` reports `demo: false` and `cloud_ai_enabled: false`. Saved secrets and prior databases were preserved.
- The configured provider is Serper. A neutral `example.com` credential test returned HTTP 403; the actual app adapter confirmed the provider response `Unauthorized.`. No personal name or scan data was sent during these checks. No working live search is claimed; correct provider/key remains required.
- New scan reuse now includes provider in both the recent-scan lookup and transactional insert guard. Existing demo reports remain fictional; new live requests cannot reuse those scans.
- Authentication errors now show a safe, actionable credential message without saving the provider response body or key.
- `npm test -- --no-cache`: **220 tests pass across 18 files**. New regression checks cover switching mock/session to Serper without external calls, same-provider reuse, rate accounting and safe handling of mocked HTTP 403 responses.

## Individual and business MVP

- `npm test -- --no-cache`: **217 passing tests across 18 files**, with mocked external services. Added coverage for business validation, legacy individual defaults, person/company identity separation, business sender/site reuse, safe website context, representative signatures, copyright declarations, business name matching and neutral public contact listings.
- Fixed and tested separate mock fixture caches for people and businesses sharing a name. Live search cache semantics remain unchanged.
- Local Worker restarted on port 8787 with the updated API. `/api/config` reports `demo: true` and `cloud_ai_enabled: false`. Browser assets have versioned links to refresh previously cached JavaScript/CSS.
- Actual browser business flow: fictional Northstar Demo Studio intake → completed report → company-specific draft signed by Alex Example. Copy, reporting-form and sent actions remained disabled until review. No external report was sent.
- Individual/business selector preserves an existing minor selection and keeps the form in individual mode with an explanation. Business authority must be reconfirmed after changing modes; representative name is required.
- Desktop (1280px) and mobile (390px) business forms checked without horizontal overflow. No captured console warnings/errors. Temporary viewport override reset.
- Synthetic QA scans were deleted after verification. Existing local data, secrets, privacy flags and the URL-only intimate-content workflow were preserved; no deployment or live-provider precision test was performed.

## 123 Reputation brand pass

- Reused the exact website logo, colour tokens and locally served Inter Tight font, with its OFL license. Five pages share the same navigation, buttons, cards and footer.
- Browser checks at 1280px desktop and 390px mobile: home, report/draft dialog, known-URL intake and populated queue, safety resources and help-request form. No horizontal overflow or captured console warnings/errors; local Inter Tight loaded successfully.
- A fictional scan completed and generated a template draft with copy/report/sent actions disabled until review. A fictional known-URL queue rendered plain-text URLs and retained its review gate. Both test records were deleted after verification; no external report was sent.
- Existing element IDs, form field names and behavior attributes were preserved. JavaScript changes are limited to two display strings. Backend, secrets and privacy configuration were untouched; `/api/config` still reports `cloud_ai_enabled: false` and demo mode.
- CSS parsing and contrast checks passed. Muted text on canvas: 5.68:1; teal on canvas: 5.91:1; navy on gold: 9.58:1. No new network font or tracking request was added.
- `node --check` passed for both application scripts. Wrangler dry-run bundled the Worker and branded local assets; no deployment.

## Cloud AI disabled — current privacy change

- `npm test -- --no-cache`: **178 passing tests across 18 files**. No live AI or search calls were made.
- New regressions configure both saved-key names and prove missing/false cloud enablement blocks AI network calls at the client boundary. Real-SQLite workflow tests verify local planning, classification and saved template drafts still work with a zero AI budget and record no AI tokens or cost.
- `/api/config` reports cloud AI as disabled in this setup; the intake privacy copy distinguishes local classification/drafting from external live search and page-text fetches.
- `wrangler deploy --dry-run` passed for the guarded Worker and static assets; no deployment. `public/app.js` syntax check passed.
- Installed MVP rechecked at `http://localhost:8787`: `/api/config` reports `demo: true` and `cloud_ai_enabled: false`; both scanner and URL-only takedown smoke checks passed and deleted their synthetic records. No platform report was sent.
- The requested OpenAI adapter was never installed. No live OpenAI acceptance test or local language-model inference is claimed.

## Earlier baseline checks

- `npm install`: completed with Node v22.23.2 and npm 10.9.8.
- `npm test -- --no-cache`: **167 passing tests across 18 files**. Network calls are mocked. API and concurrency tests run production SQL against SQLite behind a D1-compatible adapter.
- `wrangler deploy --dry-run`: built the Worker and nine static assets successfully with Wrangler 4.137.0, including the new URL-only module/page. No upload/deployment was made.
- `node --check` for `public/app.js`, `public/takedowns.js` and `scripts/smoke-takedowns.mjs`: passed.
- `npm run check-links`: **18 HTTP 200, 3 verified browser-security restrictions, 0 unreviewed failures**. X, Glassdoor and Cloudflare restrictions remain visible in checker output, with verification sources and dated expiry rules. See `scripts/verified-help-links.md`.

The suite covers text/name matching and two-character names; query construction/expansion; deduplication, domain caps and ranking; fetch media/private-host/redirect/content-type/byte guards; classifiers and provider adapters; budget/cache operations and atomic spend reservation; RDAP parsing and contacts; eligible templates and bounded draft fallback; validation, minor/sensitive routing, capability-scoped hit actions, rate limits, concurrent scan reuse, status tracking, imports and deletion.

The new URL-only queue adds 41 tests. They cover authority and non-consent validation, under-18/uncertain-age support without saving intake, preserving exact media URL query strings/fragments as data, rejecting unsafe URLs, official hostname matching, case/item isolation, the exact 14-day boundary, original timestamps after duplicate submissions, concurrent terminal-state/reference changes and full deletion. Every test asserts that the module made zero outbound `fetch` calls.

## Actual local Worker and D1

Both modes were checked with isolated configuration and synthetic data, using `scripts/smoke-local.mjs`:

- **Mock:** reached `done`, displayed ten results and ten additional mentions, generated Reddit and unmapped-site drafts, persisted status and a request, deleted the scan, and returned 404 afterwards. No paid service or fixture-page fetch occurred.
- **Session:** planned/exported queries, imported exact-query results, deduplicated/classified them, reached `done`, stored a request, deleted the scan, and returned 404 afterwards. The synthetic result used a blocked loopback URL, exercising snippet-only classification without visiting a website.
- **URL-only queue:** `node scripts/smoke-takedowns.mjs http://localhost:8790` passed against staging Worker/D1, then `node scripts/smoke-takedowns.mjs` passed against the installed MVP on port 8787. Checked age-only help, a fictional Reddit URL and `.example` media URL, platform/unknown routing, manual-send accuracy gate, a past original sent date with an overdue reminder, duplicate preservation, manual follow-up, closing outcomes and deletion/404. The script only permits loopback demo mode and deletes its synthetic case.
- The new local page, script and config return HTTP 200. The case page sends `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow` and a same-origin connection CSP. The HTML contains no image, video or frame elements.

Real SQLite tests independently verify removal of every scan-linked query, hit, draft, request, cache association and cached result. Daily aggregate spend/rate counters remain by design and contain no names, URLs or scan IDs. Concurrent duplicate requests create one scan and consume one rate slot; simultaneous different names cannot exceed the configured rate limit.

## Browser verification

The original name-scanner pages passed desktop and 390px mobile checks with no horizontal overflow and no console errors or warnings:

- Create a mock scan, view progress, ten cards and the additional-result banner.
- Discover and edit Reddit/unmapped-site drafts; enforce the accuracy checkbox before copy/form/email/sent actions.
- Persist sent and Not me states; retain same-name clarification after reload.
- Offer copyright only with adult ownership; show help first for minors and specialist help without a scan for sensitive selections.
- Save a synthetic expert-help request with its selected result ID.
- Exercise quick exit and deletion-confirmation cancellation. Actual deletion is covered by HTTP/runtime and SQL tests.

No removal request, email or partner message was sent.

The new URL-only page passed source checks for syntax, unique IDs, label targets and no inline scripts/styles. Review found and fixed a stale-tab receipt overwrite: the UI now sends a platform reference only when the user changes it.

After the browser extension was installed, the previously blocked interactive walkthrough passed in the in-app browser using fictional demo data:

- Create an adult queue and show known-platform versus unknown-host reporting groups.
- Keep copy/form/sent controls disabled until review; editing resets confirmation, and closing/reopening preserves draft edits.
- Record a fictional sent date of 1 September, display its 15 September reminder as overdue, and clear the reminder when a follow-up is recorded.
- Save a platform reference in one tab, then save unchanged details from a stale second tab; preserve both the reference and original dates.
- Switch prefilled adult intake to uncertain age and submit successfully with adult fields hidden; independently submit under-18 intake and show specialist support without a queue.
- Keep source URLs as plain text; the rendered page contains zero source hyperlinks and zero image/video/frame elements. Unknown hosts have no official-form action.
- Cancel the deletion dialog and retain the case. No real request was submitted and no source site was opened.

The rendered queue was inspected at the actual 462px viewport with no horizontal overflow. The requested wider viewport override did not apply, so a wide desktop layout is not claimed as newly verified. No console warnings or errors were captured in either the queue or support-flow tab. The viewport override was reset. The fictional case remains as demo data in the isolated local demo database.

## Not claimed as validated

- Real-provider end-to-end behaviour, billing/prices or classification accuracy.
- The plan's 80% precision threshold on the owner's real self-search with reviewed labels.
- Production D1, secrets, Turnstile or deployment.

The existing project `.dev.vars` was preserved. Development and tests used temporary mock/session configuration.
# 2026-09-30 — Follow-ups and branded reports

- Full regression run: 672 tests across 34 files passed. Final focused run after closure/overdue checks: 29 tests across 3 files passed (including 3 newly added tests).
- Mocked Gmail/Outlook tests verify optional offline grants, encrypted content, exactly fourteen days across leap day, atomic concurrent claims, no early send, refresh failures, ambiguous outcomes, owner isolation, cancellation, disconnect and overdue holds. No live email sent.
- Browser QA: dashboard loads, fictional scan shows ten included / ten excluded results, notes persist, police/law-firm/PR previews render, PR omits identifying content. Downloaded fictional HTML embeds the logo and styles and contains no scripts. Removal-request page loads without console errors.
- PDF uses the browser print dialog; a saved PDF was not independently inspected. Real OAuth credentials are still absent and local Wrangler cron does not run automatically. Production scheduling requires provider setup and hosted cron.

# 2026-10-01 — SSH and remote engine compatibility

- The user had the device's new Ed25519 public key installed on `<your-vps-ip>`. SSH identity check succeeded for the configured administrative user. No private key or server settings secret was read into tool output.
- Verified the dedicated `reputation-searxng` container: version `2026.7.12+c19d86faa`, loopback `127.0.0.1:8890`, read-only mounted settings and recipe, Docker log driver `none`. The separate stock service was untouched.
- Backed up active settings privately to `/var/lib/123-reputation-searxng/config/settings.yml.pre-general-web.20261001T105440Z`, then surgically enabled regular Google, Brave and Google CSE. All three loaded.
- Individual-engine neutral probes: Google0, Brave0, CSE20 for each of `example.com`, `wikipedia`, `OpenStreetMap`. Empty failed-engine arrays did not establish engine health. No personal query or source/media fetch occurred.
- Restored the original CSE-only settings and restarted only the dedicated container. The protected HTTPS adapter again returned20 CSE results, partialfalse, for `example.com`.
- Official upstream PR6546, merged22 August2026, repairs Google after the deployed July build: https://github.com/searxng/searxng/pull/6546 . It also changes shared helpers/CSE, so a live single-file backport was avoided.
- Automatic approval review rejected an unpinned `latest` image pull as an unapproved persistent software/storage change. No image was downloaded. Read-only official registry metadata identified `2026.9.30-a9d990033`, immutable digest `sha256:a07a5cd2da2c63d66e559f9e4d3a3db106cfc6c32fb0ac70abe91cc28bcd7350`; its isolated compatibility test awaits explicit user approval.

# 2026-10-01 — Missing-result investigation and coverage fixes

- The user's fresh report `43f24685-2db1-4584-b4c5-51bb02005fc0` still showed 2 flagged mentions, 16 reviewable matches and 7 professional exclusions. It recorded no sensitive exclusions. The screenshot's missing listings have **not** been confirmed recovered.
- Authenticated read-only `/config` on the configured remote instance exposed only `google cse` in the general engine list. A neutral `example.com` request specifying `google` still returned entries attributed to `google cse`. A separate explicit `google cse` request returned 20 entries, no reported failed engines. No personal discovery query or source/media page was fetched for these checks.
- Google documents that Programmable Search searches a subset of its web corpus and differs from Google.com: https://support.google.com/programmable-search/answer/70392?hl=en . This confirms an upstream coverage constraint, but the historical record lacks raw-return/filter diagnostics needed to explain each absent URL individually.
- Fixed the three 20-entry web truncation points. The adapter, relay and browser pipeline now retain up to 100 validated entries per response, keeping the existing byte bound, source-page restrictions and first-10 display limit. Autocomplete remains limited to 20.
- New scans record only aggregate provider/filter counts and allowlisted engine names. The report distinguishes actual recorded engines from the current connection and identifies historical diagnostics as unavailable. No raw provider errors, credentials, queries or source-media fields were added to the relay DTO.
- Reputation keyword queries take priority over extra alias/handle queries. The user authorised more than 12 requests; local `.env` now has `MAX_QUERIES=24`. Restarted the preview; `/api/config` verified 24. Existing saved reports keep their original query history.
- Full regression: **719 tests passed across 37 files**. Includes a name match after position 20, cap100/first10, alias budget, repeated partial responses, historical unknown counts and configured24 quota reservations/exhaustion. Browser bundle rebuilt; user's current report shows the CSE limitation and accurate exclusions; console errors empty.
- Prepared broader-engine configuration separately. It is **not deployed**: server setup notes reference an SSH key on another computer, absent here. The user chose regular Google plus another general engine on the existing server. Need server administration access and neutral per-engine runtime verification before claiming this part complete.

# 2026-10-01 — Live upgrade and retained findings

- Subsequent to the earlier entry, the user installed this device's public SSH key and separately approved the pinned-image compatibility test and live upgrade. Google + Bing + Google CSE are now configured on the dedicated service. See `deploy/searxng/LIVE-UPGRADE.md` for the verified image, rollback container, private backup and successful network-preserving restart. Neutral connection checks do not establish coverage for every query.
- The latest saved report had 45 reviewable matches, three automated flags and six professional exclusions. Its request audit attributed usable listings only to Bing and Google CSE; regular Google contributed none. No source-specific reason for the screenshot's missing entries has been established, and those entries are not claimed recovered.
- Fixed premature snippet/title truncation before name matching and duplicate metadata enrichment. Later matching metadata can strengthen a concern while preserving URL identity, user status and draft/history records. A sensitive classification remains guarded.
- New scans retain safe findings from older browser records only when the subject and supplied identity context match. The current row wins on canonical duplicates; older not-me/sensitive findings are suppressed. Observation dates remain original until a real current response returns that URL. Retention does not make search requests or change existing records.
- Added a local-only history action for preexisting reports. In browser QA, it added five earlier saved findings to the current report: three reviewable and two professional exclusions. Both original flagged URLs are now in the first ten; the formerly absent one is labelled as an earlier observation. Current totals are 48 reviewable matches, four automated flags and eight professional exclusions.
- Verified the request audit was unchanged: 24 completed queries, 326 listings, 250 without a supplied-name match, 25 duplicate URLs, zero invalid/limited entries and 51 new matches from those responses. Historical findings are described separately rather than counted as new provider results.
- Dashboard QA verified the current report still exports ten items, with 38 additional results outside the preview. The restored row includes its earlier UTC observation time. Historical provenance is included in police/legal/PR presentation; private prior scan/hit IDs and hidden rows remain omitted. No email or report was submitted; no source/media page was opened.
- Full local regression: **798 tests passed across 40 files**. Browser bundle rebuilt and script syntax checks passed. Dashboard console errors/warnings were empty. Visual proof is saved at `artifacts/coverage-history-proof.png`; the temporary QA tab was closed and the user's current report kept open.
- A bounded neutral parameter comparison used the actual app adapter with `OpenStreetMap`, English, POST JSON, SafeSearch off and page one. Google alone returned zero usable attributed results; the combined request returned 30 (Bing 10, Google CSE 20, Google zero). Both reported no partial/failure labels. Preflight and live search share the same adapter; no parameter mismatch or proven configuration repair was identified. This reproduces Google's silent empty response without a personal query or local name filtering. Increasing the request allowance would not itself repair that failure.

# 2026-10-01 — Consented SerpApi backup connected

- The user selected SearXNG as default and SerpApi as backup, then supplied the key in private `.env`. `SERPAPI_API_KEY` is server-only and `.env` remains Git-ignored. Existing connection credentials were preserved.
- Removed the SearXNG English-only request filter. EN/ALL neutral comparisons did not establish that language caused the missing Google listings. Installed SearXNG suppresses engine failure details when `display_error_messages` is false, so empty failure labels do not prove successful engines. The root cause of its empty Google responses remains unconfirmed.
- A consented query can make one independent SerpApi request when regular Google is missing. The app preserves primary results on backup failure, labels Google via SerpApi separately, meters the two providers separately, and enforces a configurable shared daily backup cap. A missing cost estimate is shown as unknown rather than free. Older scans do not acquire new third-party consent automatically.
- SerpApi requests use documented page offsets and `no_cache=true`, with fixed endpoints, manual redirects, response/body deadlines, bounded JSON, sanitized text-only organic results and conserved counts. The relay allows 28 seconds for two bounded providers; the browser transport allows 30 seconds for search.
- The complete offline suite passed: **1,048 tests in 42 files**. A final focused startup check also covers the no-country backup request used in the SearXNG workflow.
- Actual neutral adapter validation returned **8 Google results** through SerpApi. Restarted startup verified **Bing 10** and **SerpApi Google 8**; regular SearXNG Google and CSE returned no attributed results in those probes, so startup accurately reports degraded primary coverage.
- Actual authenticated local relay validation for `wikipedia` returned **18 listings: 10 Bing plus 8 Google via SerpApi**, `google_recovery=recovered`, `attempts=2`, with no partial response. The temporary operator session was logged out afterward. No personal query, source page, media or email was fetched/sent for this validation.
- Browser QA confirmed the SerpApi consent checkbox can be checked and unchecked, the named backup appears in consent/privacy text, and the existing saved report explains that a new scan needs the updated consent. Screenshot: `artifacts/serpapi-consent-proof.png`.
- These checks establish working retrieval and fallback, not exact parity with Google.com, completeness, legal accuracy or recovery of the specific screenshot URLs.


## 2026-10-01 — Clearer result labels

The report cards now separate a possible topic from the suggested review order. Unexplained numeric severity badges were replaced with “Review first”, “Review next”, “Review context” or “Check identity first”. Each card has a keyboard-accessible “Why this label?” disclosure explaining topic detection, priority and identity uncertainty. Raw internal keyword-reason strings are no longer used as the user-facing explanation. Classification, ranking, saved findings and request tracking are unchanged.

Validation: eight focused label-guard tests passed, including stale high scores on neutral results, excluded identities, malformed confidence and unknown categories. JavaScript syntax checks passed. The actual latest saved report was reloaded without starting a new scan; the topic badges and expanded explanation rendered correctly at a 512px viewport with no horizontal overflow. Proof: `artifacts/result-labels-proof.png`.
