# Reputation Scanner: privacy architecture

This repository is public so that anyone, including regulators and government
agencies, can check what the Reputation Scanner stores and sends. This page
summarises the design. The code is the authority: the server entry point is
`src/private-worker.js`, the browser data layer is `src/browser-api.js` (bundled
into `public/local-api.js`), and the server database schema is `schema.sql`.

The scanner is free, open-source software. Whoever hosts a copy is its operator and is responsible for reviewing `public/privacy.html` and `public/terms.html` for their deployment.

## What stays in your browser

Scans, names and other search details, results, labels, notes, removal-request
drafts, known-URL cases, statuses and 14-day reminders are saved in the
browser's IndexedDB (`src/browser-store.js`). They are not uploaded to our
server database. They stay on the device until you delete them or clear the
site's data. Matching, ranking and request templates run in the browser.

Retired server routes that once stored scans (`/api/scan`, `/api/hit`,
`/api/takedowns` and others) return HTTP 410 before reading the request.

## What reaches our server

The browser can call only an allowlisted set of routes (see `send()` in
`src/browser-api.js`). The server receives:

- **Search queries, only after you consent to live search.** Query text is
  relayed to the search provider and is not written to the database. The
  Worker has observability turned off, and responses are `no-store`.
- **Hashed quota metadata.** To enforce three public scans per day, the server
  stores a keyed HMAC of your IP address that changes daily (IPv6 is counted per
  /64), plus search-permit hashes and counters. The raw IP address, queries and
  results are not stored (`src/operator-access.js`, `src/quota-usage.js`,
  `src/public-abuse.js`). Aggregate daily usage totals are kept for 30 days.
- **Assistance requests you choose to send.** The contact form sends your name,
  email, help type, message, any links you type in and any report attachment
  you preview and choose to include. The server emails them to the 123
  Reputation Management team through Cloudflare Email Routing
  (`src/assistance-mail.js`). After the email is delivered, the database keeps
  only a receipt with no content (id, time, help type, delivered flag). If
  delivery fails, the full request is kept so it is not lost. All of these
  rows are deleted after 30 days. Partner organisations are contacted only
  with your agreement.
- **Encrypted email follow-ups, only if you connect email sending.** If you
  connect Gmail or Outlook to send a removal request, the server keeps
  encrypted OAuth credentials and the approved follow-up text for up to 30
  days so one follow-up can be sent after 14 days. Inboxes are never read
  (`src/email.js`).
- **Hostnames for abuse-contact lookup.** When you open a request for a site
  that is not on the curated list, only its hostname (never the page URL) is
  sent to our server and on to public DNS and domain-registration (RDAP)
  services to find an abuse contact (`src/reporting-contact.js`,
  `src/abuse.js`).
- **One result's details, only if you choose "Draft with AI".** See
  [AI drafting (opt-in)](#ai-drafting-opt-in) below. The prompt and draft are
  not stored; only daily counters change.
- **Operator sessions.** Staff sign-in stores only hashed, expiring session
  tokens and login-throttle counters.

Expired metadata is removed by the hourly cleanup (`cleanPrivateMetadata` in
`src/quota-usage.js`, `cleanupEmail` in `src/email.js`). Cloudflare D1 keeps
its own point-in-time recovery history (Time Travel) for a limited period,
so deleting a row is not immediate erasure from all backups.

Source pages and images are never fetched. The only server-side AI use is the
opt-in drafting described below; the legacy cloud-AI flag
(`CLOUD_AI_ENABLED`) stays off and no scan content is sent to AI automatically.

## Third parties

| Service | When | What it receives |
| --- | --- | --- |
| Cloudflare (Workers, D1, Static Assets, Email Routing) | Every visit | Hosts the app and database and delivers assistance emails. Processes network requests under Cloudflare's terms. |
| Cloudflare Turnstile | Public scan starts and contact requests, when enabled | Your IP address and browser signals, for bot checks. The server sends only the challenge token to Siteverify, not names, queries or form content. |
| Search provider: self-hosted SearXNG | Live searches you consent to | Query text. SearXNG forwards it to the configured engines (currently Google, Bing and Google CSE), which may keep queries under their own policies. |
| SerpApi (optional Google backup) | Only if configured and you separately consent | The same query text, when SearXNG returns no usable Google listings. |
| Public DNS (Cloudflare DNS over HTTPS), IANA RDAP bootstrap, rdap.org and registry RDAP servers | When you open a request for an unlisted site | The site's hostname only. |
| Gmail or Microsoft Graph | Only if you connect email sending | The messages you review and approve for sending. |
| AI provider (default OpenAI, `AI_PROVIDER` / `AI_PROVIDER_NAME`) | Only if AI drafting is switched on and you consent for one draft | That one result's title, link, snippet, platform name, request type and the facts you type (see below). |

## AI drafting (opt-in)

AI drafting is off unless the operator sets `AI_DRAFTING_ENABLED=true` and an
`AI_API_KEY` secret (`src/ai-draft.js`). It is separate from the legacy
`CLOUD_AI_ENABLED` flag, which stays `false`. When it is off, `GET /api/config`
reports `ai_drafting_enabled: false` and the "Draft with AI" button is not shown.

When it is on, this is the exact data flow for one draft:

1. **Consent, every time.** You click "Draft with AI" next to the template
   draft. A consent screen names the provider (from `ai_provider_name` in
   `/api/config`) and lets you type optional facts (at most 2,000 characters).
   Nothing is sent unless you tick the consent box and confirm. There is no
   "remember my choice"; the next draft asks again (`public/ai-draft.js`).
2. **Browser to our server.** The browser sends `POST /api/draft-ai` with only:
   `consent: true`, the request type, the result's link, title (max 500
   characters), search snippet (max 2,000), platform name (max 120) and your
   facts (max 2,000). It does not send your name, email, other results, scan or
   case IDs, country or context fields (`src/browser-ai-draft.js`,
   `src/browser-scans.js`). On the known-URL removal queue it sends only the
   link, platform name, the request type `intimate_image` and your facts; no
   title or snippet exists there. To pass the bot check, the request carries
   either today's scan permit for this network or a Cloudflare Turnstile token.
3. **Server checks.** The Worker applies the same-origin and JSON checks used by
   other APIs, rejects unknown or oversized fields, and requires
   `consent: true`. It then checks a per-network daily cap
   (`AI_DRAFTS_PER_IP_DAY`, default 10, stored as a count against the same
   daily-changing keyed IP hash used for scan quotas, IPv6 counted per /64) and
   reserves the worst-case cost against a global daily budget
   (`AI_DAILY_USD_LIMIT`, default USD 5). If any check fails, nothing is sent
   to the provider and you are told to use the template draft.
4. **Server to the AI provider.** The Worker builds the prompt itself: a fixed
   system prompt (polite, factual, no legal threats, no invented facts, no
   claim of legal representation, placeholders such as `[your name]`, short)
   plus your fields as JSON inside a randomly delimited "untrusted data" block,
   so text in a snippet or in your facts cannot change the task. It sends this
   over HTTPS to the provider (default: OpenAI Chat Completions API,
   `https://api.openai.com/v1/chat/completions`, model `gpt-5-mini`,
   `max_tokens` 800, 20-second timeout).
5. **Draft back to your browser.** The server returns `{ draft, model,
   provider }`. Your browser fills in your name and email locally, shows the
   draft in the normal editable draft area labelled "AI draft — check every
   detail before sending", and saves it in IndexedDB like a template draft.

**What our server keeps:** no prompt, no draft and no result details. It does
not log them or write them to D1. It changes two counters only: the per-network
daily count in `public_abuse_counters` (keyed IP hash, expires at the next UTC
midnight) and the day's totals in `ai_draft_usage` (requests, successes,
failures, input/output tokens and estimated USD cost; purged after 30 days).
Provider errors are not logged or passed on.

**What the provider keeps** depends on its terms and the operator's account
settings (for example, zero-data-retention agreements). This repository cannot
show those settings; the operator must confirm them with the provider.

## Verifying a deployment

- `GET /api/config` reports `storage: "browser"` and `cloud_ai_enabled: false`.
  `ai_drafting_enabled` and `ai_provider_name` show whether opt-in AI drafting
  is on and which provider receives drafts.
- `deploy/cloudflare/wrangler.production.example.jsonc` shows the production
  configuration: no workers.dev or preview URLs, observability off, and the
  assistance email binding.
- `test/ai-draft.test.js` and `test/browser-ai-draft.test.js` check AI
  drafting consent, caps, budget, prompt delimiting and that D1 receives no
  prompt or draft content.
- `test/private-worker.test.js` and `test/browser-api.test.js` check the
  network boundary, for example that local record IDs and private fields
  never leave the browser and that assistance is stored only when email
  delivery fails.
