# 123 Reputation Management — application codebase

Source snapshot of the **Reputation Scanner** app, last updated **4 October 2026**.
See `PUBLIC-REPO.md` for what the app stores and sends, written for public verification.

## What is included

| Path | Purpose |
| --- | --- |
| `src/` | Browser storage, scans, removal workflows, matching rules, active Worker API, operator access and abuse controls |
| `public/` | Application pages, styles, scripts, generated browser bundle, supplied logos, favicon and local font |
| `test/` | Automated unit and integration tests with synthetic data |
| `scripts/` | Browser build, smoke/link checks and operating notes |
| `deploy/searxng/` | Dedicated private SearXNG container recipe and operating guide |
| `deploy/cloudflare/` | Cloudflare deployment guide and production configuration template |
| `schema.sql` | Database schema; active server tables hold operational metadata and assistance receipts (full requests only when email delivery fails) |
| `package.json`, `package-lock.json` | Commands and pinned dependency resolution |
| `.env.example` | Current configuration template, with empty secret fields |
| `README.md`, `PLAN.md`, `VALIDATION.md`, `BRAND.md` | Product behavior, current direction, validation history and brand guidance |
| `PUBLIC-REPO.md` | Privacy architecture: what stays in the browser, what reaches the server and which third parties are involved |

The active server entry is **`src/private-worker.js`**, selected by `wrangler.jsonc`.
Earlier server-storage/AI modules and their tests remain for reference; do not switch the entry to `src/index.js`.
`public/local-api.js` is generated: edit its source and run `npm run build:browser`.

## Install and verify

Use **Node 22.23 or newer** and npm; integration tests use `node:sqlite`.
From this directory:

```sh
npm ci
npm test -- --no-cache
npm run build:browser
```

These checks do not require real search credentials. Unit/integration tests use synthetic data and mocked external services.
There is no separate package manifest; the test suite and `VALIDATION.md` record verification.

## Configure a separate local preview

The source package excludes private configuration. A private, git-ignored `.env` holds local quota/operator secrets and, for live search, a SearXNG gateway URL and proxy key. The live launcher enables the relay only after a successful preflight. No local SearXNG installation or SSH tunnel is needed when an HTTPS gateway is configured. Use `.env.example` for fresh copies; `.dev.vars.example` is a historical reference with obsolete server-import instructions.

Copy `.env.example` to a new private `.env` only if none exists. For an explicitly local preview, use `LOCAL_DEVELOPMENT=true` and `TURNSTILE_ENABLED=false`; retain `CLOUD_AI_ENABLED=false`. Generate distinct private `RATE_LIMIT_SECRET` and `OPERATOR_ACCESS_KEY` values as described in `scripts/operator-dashboard.md`.

Live SearXNG additionally needs the verified dedicated service and an authorised connection described in `deploy/searxng/README.md`. Host addresses and SSH key paths in that guide are placeholders such as `<your-vps-ip>`; substitute your own. The private key and remote service are not bundled. Enable `ALLOW_SEARCH_RELAY=true` only after that connection is configured and checked.

The existing project already uses port 8787. To run this copy independently on **8788**, after configuring its private `.env`:

```sh
npm run check:live
npm run dev:live
```

`check:live` runs one neutral `example.com` search without exposing credentials or result text. `dev:live` checks the same connection, builds the browser bundle, initializes an isolated `.wrangler/live-state` database and starts at `http://127.0.0.1:8788`. Stop the demo preview first to free port 8788. The launcher enables the relay only after nonempty, nonpartial live results are verified; it never falls back to demo results. It forces local development, cloud AI off and no external bot challenge on loopback. Keep the search tunnel running. Browser records belong to the exact hostname and port; `localhost` and `127.0.0.1` are separate origins.

## Current product and launch status

- General reputation scans support individuals and authorised businesses, including scam/fraud mentions. Results are allegations and matching estimates, not verified facts.
- Scan results, drafts, known-URL cases and 14-day reminders live in the browser. Server persistence is limited to access/quota/usage metadata and assistance receipts. Assistance the user explicitly submits is emailed to the team; it is stored in D1 only if email delivery fails, and purged after 30 days.
- Cloud AI is not used automatically, and there is no image/source-page fetching. Optional **Draft with AI** (off by default; `AI_DRAFTING_ENABLED`) sends one result's details to the AI provider only after per-draft consent and stores nothing server-side; see `PUBLIC-REPO.md`. Intimate-content support uses known URLs and specialist resources; it does not provide targeted intimate-image discovery.
- Public users receive three scan starts per IP per UTC day. Authenticated operators have no daily scan cap, with finite per-scan workloads and short-term service controls.
- The dedicated SearXNG service was upgraded on 1 October 2026 to **Google, Bing and Google CSE** (`SEARXNG_ENGINES=google,bing,google cse`; see `deploy/searxng/LIVE-UPGRADE.md`). Bing supplies first-page listings only, and regular Google sometimes returns no listings; an optional, consent-gated SerpApi Google backup covers that case (`SERPAPI-SETUP.md`). Yahoo is not enabled. The production example still uses `google cse` alone until hosted acceptance.
- `app.123reputationmanagement.org` is the planned hostname. Cloudflare configuration is prepared, but public deployment, hosted security acceptance and SearXNG Containers migration are pending.

Read `PLAN.md` and the newest entries in `VALIDATION.md` before continuing implementation. Older validation entries describe historical behavior and do not override the current handoff.

## Excluded material

The package excludes actual secrets, `.wrangler` runtime/database state, `node_modules`, logs, browser data and SSH private keys. Install dependencies using the lockfile and configure credentials separately. The main corporate website, full designer source folder and other research tooling are separate projects; the logo/font assets used by this app are included here.
