# Cloudflare hosting for 123 Reputation Management

Confirmed application hostname: **app.123reputationmanagement.org**.

This is a deployment preparation guide, not evidence of a public deployment.
The local preview remains on `http://localhost:8787`. Moving to the production
origin does not move IndexedDB records from localhost; no automatic upload or
migration is part of deployment.

## Application and data

Use one Cloudflare Worker with Static Assets for the frontend and API. The
existing `src/private-worker.js` remains the entry point. The production
Worker is named `reputation-scanner`. D1 holds only operational metadata,
aggregate usage and assistance receipts (or, only when email delivery fails,
the explicitly submitted request itself, for at most 30 days).
Names, search results, drafts, known-URL queues and reminders remain in the
visitor's browser. No R2 scan archive is needed. Optional, opt-in AI drafting
is described in its own section below and ships switched off.

`wrangler.production.example.jsonc` contains the confirmed Custom Domain,
disabled workers.dev/preview URLs, no Worker observability, hourly cleanup,
public query budgets and enabled abuse protection. It deliberately has no
real database ID, Turnstile key, search URL or secrets; the search relay stays
off until hosted acceptance succeeds. Cloudflare must already manage the
domain's zone for the Custom Domain route.

Provision a **new** production D1 database and apply `schema.sql`. Do not copy
the historical local database or its old case tables into production. The
schema is additive; it does not read or migrate old records.

## Public abuse controls

- Three public scan starts per IP per UTC day, plus a 60-second cooldown for
  new starts. Retrying the same valid permit does not use another daily slot.
- Verify Turnstile on the server before issuing new public permits or accepting
  public assistance. Validate the exact hostname and the `scan_start` or
  `assistance` action. Missing/failed hosted bot configuration must fail closed.
- Throttle repeated permit/challenge, relay and assistance attempts.
  Contact submissions also have a three-per-IP hourly limit. Apply Cloudflare
  edge rate limits to the API paths before launch to absorb traffic before it
  reaches Worker/D1; exact rule availability depends on the Cloudflare plan.
- Database-backed expiring leases cap simultaneous search requests globally
  and per caller. Operators keep unlimited daily scans but cannot overwhelm
  the search service with unlimited parallel calls.
- Keep the global public query/spend budget. `ALLOW_SEARCH_RELAY=false` is the
  server configuration switch to pause new provider work for both audiences.
  No dashboard pause button is implemented.

IP limits are not identity verification. Shared networks share an allowance;
proxies or changing addresses may evade it. A self-search checkbox cannot
prove authority. Current permits bound request volume but are not bound to an
approved query plan; tightening that is follow-on work. Do not advertise the
app as preventing all misuse or as a verified identity search service.

For the local preview only, `.env` uses `LOCAL_DEVELOPMENT=true` and
`TURNSTILE_ENABLED=false`. The bypass is restricted to exact loopback hosts;
the server throttles still operate. Hosted deployment must never use this
local setting. Turnstile test keys belong only in isolated testing.

## Configuration and staff access

Public variables in the example config include the production Turnstile
site key, exact expected hostname, fixed SearXNG HTTPS URL and engine list.
Install secrets with Wrangler's secret store or the Cloudflare dashboard:

- `RATE_LIMIT_SECRET`: a new, random, production-only secret (32+ characters).
- `OPERATOR_ACCESS_KEY`: a distinct production-only secret (32–256 characters).
- `TURNSTILE_SECRET_KEY`: paired with the production site key, restricted to
  the confirmed application hostname in the Turnstile widget configuration.
- Search gateway authentication: either `SEARXNG_TOKEN`, or the pair
  `SEARXNG_ACCESS_CLIENT_ID` / `SEARXNG_ACCESS_CLIENT_SECRET` for an Access
  Service Auth policy. Both mechanisms can be combined if the origin also
  checks a bearer token. The browser must never receive these values.

Before launch, configure Cloudflare Access for staff dashboard/login paths
(`/admin*` and `/api/operator/*`), allowing named staff through an identity
provider with MFA. Do not apply interactive staff Access to the public app
or its public scan API. The current app still authenticates operators with
its shared key and revocable eight-hour app sessions: Access is a proposed
additional deployment control, not an implemented replacement for that key.

Access on dashboard paths alone does not re-evaluate an existing operator
app cookie at the public `/api/search` endpoint. To require Access on every
privileged operation, add verified Access JWT enforcement in the Worker or
move staff operations to a separately protected hostname. That integration
and individual operator identities remain follow-on work. No Access policy,
MFA enrollment, DNS record or cloud resource was created by these changes.

## Assistance email delivery

Contact and assistance requests (including links the user types in, such as
private Telegram groups) are emailed to the owner's inbox with Cloudflare's
native `send_email` binding. The Worker builds a plain-text UTF-8 message with
the help type, name, reply-to email, message, shared links, timestamp and
request ID, and sets `Reply-To` to the user's address when it is a safe,
ordinary address. When the binding accepts the message, D1 keeps only a
content-free receipt (`id`, `created_at`, `help_type`, `delivered = 1`). If
the binding is missing or the send fails, the full request is stored in D1
(`delivered = 0`) so it is not lost, and the user is told it was received.
The hourly cleanup deletes every `assistance_requests` row older than 30 days.

Addresses used in production:

| Setting | Value |
| --- | --- |
| Destination (`send_email[0].destination_address` and `vars.ASSISTANCE_TO`) | `hello@123reputationmanagement.org` (verified Email Routing destination) |
| Sender (`vars.ASSISTANCE_FROM`) | `scanner@notify.123reputationmanagement.org` (no mailbox needed) |

> **Never enable Email Routing on the root domain `123reputationmanagement.org`.**
> The root's MX records point to 20i StackMail, which hosts the
> `hello@` inbox. Enabling Email Routing on the root replaces those MX
> records and would break all inbound mail to the domain. Email Routing is
> enabled on the subdomain `notify.123reputationmanagement.org` only, and
> the Worker sends from that subdomain.

Setup (one time, in the Cloudflare dashboard for the `123reputationmanagement.org` zone):

1. **Email > Email Routing > Settings > Subdomains: add
   `notify.123reputationmanagement.org`** and enable Email Routing for that
   subdomain only. Accept the MX, SPF and DKIM records Cloudflare proposes for
   `notify.` (they are created on the subdomain, not the root). Before
   saving, check that no MX, SPF or DKIM change is proposed for the root
   domain; the root's MX must stay on 20i StackMail. (Sending through the
   binding requires Email Routing on the sender's domain, which is why the
   sender is `scanner@notify.123reputationmanagement.org`.)
2. **Email Routing > Destination addresses > Add destination address.** Enter
   `hello@123reputationmanagement.org` and click the verification link
   Cloudflare emails to it (it arrives in the StackMail inbox). The binding
   can only send to verified destinations.
3. `wrangler.production.example.jsonc` already sets
   `send_email[0].destination_address` and `vars.ASSISTANCE_TO` to
   `hello@123reputationmanagement.org` (they must match) and
   `ASSISTANCE_FROM` to `scanner@notify.123reputationmanagement.org`. Keep
   them unless the verified destination changes.
4. Deploy. Send one test request from `/contact.html` and confirm it arrives,
   that replying goes to the address entered in the form, and that
   `SELECT COUNT(*) FROM assistance_requests WHERE delivered = 0` is 0.
5. Check undelivered requests regularly until delivery is proven:
   `wrangler d1 execute reputation_app_production --remote --command "SELECT id, created_at, help_type, name, email, message, links_json, attachment_json FROM assistance_requests WHERE delivered = 0"`.
   They are deleted after 30 days.

Existing databases need two additive columns (new databases get them from
`schema.sql`):

```sql
ALTER TABLE assistance_requests ADD COLUMN links_json TEXT;
ALTER TABLE assistance_requests ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS assistance_requests_created ON assistance_requests (created_at);
```

Rows saved before the migration have `delivered = 0` and are purged by the
30-day cleanup like any other row.

## Opt-in AI drafting ("Draft with AI")

Visitors can ask for an AI-written draft for one result at a time, after a
consent screen, and the owner pays for it. It is off in both Wrangler configs
(`AI_DRAFTING_ENABLED: "false"`) and is separate from the legacy
`CLOUD_AI_ENABLED` flag, which must stay `"false"`. See `PUBLIC-REPO.md` for
the data flow. Prompts and drafts are never stored or logged; only daily
counters in `public_abuse_counters` and `ai_draft_usage` change.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AI_DRAFTING_ENABLED` | `"false"` | Master switch. Only the exact string `"true"` turns it on. |
| `AI_PROVIDER` | `"openai"` | `openai` for OpenAI or an OpenAI-compatible Chat Completions API (`AI_BASE_URL`, HTTPS, defaults to `https://api.openai.com/v1`), or `anthropic`. |
| `AI_MODEL` | `"gpt-5-mini"` | Model ID sent to the provider. |
| `AI_PROVIDER_NAME` | `"OpenAI"` | Name shown on the consent screen and privacy copy. |
| `AI_API_KEY` | secret, none | Provider API key. Set with `wrangler secret put`; never put it in a config file. |
| `AI_DRAFTS_PER_IP_DAY` | `"10"` | Drafts per network (keyed IP hash, IPv6 /64) per UTC day. |
| `AI_DAILY_USD_LIMIT` | `"5"` | Global estimated spend cap per UTC day, in USD. |
| `AI_INPUT_USD_PER_M` / `AI_OUTPUT_USD_PER_M` | `"0.25"` / `"2"` | Price per million input/output tokens used for the estimate (gpt-5-mini list prices; confirm on OpenAI's pricing page). Update them if you change the model. |

**How spend is capped.** Before each provider call the Worker reserves the
worst case (estimated prompt tokens plus the 800-token output cap, priced with
the two rates above) against `AI_DAILY_USD_LIMIT` in one atomic D1 statement,
so concurrent requests cannot overshoot. When the provider reports token usage
the reservation is replaced by the estimated actual cost; when a call fails or
reports no usage, the worst case stays charged. Once the cap is reached, or a
network uses its daily allowance, requests fail closed with a message pointing
to the template draft. A missing key, unknown provider or invalid limit also
fails closed (`/api/config` then reports `ai_drafting_enabled: false`). This is
an estimate, not the provider invoice: also set a monthly spend limit in the
provider's console (for OpenAI: the project's usage limits in the platform settings) as a hard
backstop.

**Owner setup:**

1. Create an API key in the provider console, ideally in a dedicated
   workspace/project with its own spend limit.
2. Confirm the provider's data-retention and training terms for this use, and
   whether zero data retention (or a similar agreement) applies to your
   account. Ask the provider; the app cannot verify this. Update
   `AI_PROVIDER_NAME` (for example `"OpenAI"`) and the privacy
   notice to match.
3. Install the key as a secret (it is never part of the config or the browser
   bundle):

   ```sh
   npx wrangler secret put AI_API_KEY --config deploy/cloudflare/wrangler.production.example.jsonc
   ```

   For a local preview, put `AI_API_KEY=...` in the private, git-ignored
   `.dev.vars` instead.
4. Existing databases need the new counters table (new databases get it from
   `schema.sql`; re-applying `schema.sql` is safe because every statement uses
   `IF NOT EXISTS`):

   ```sh
   npx wrangler d1 execute reputation_app_production --remote --command "CREATE TABLE IF NOT EXISTS ai_draft_usage (day TEXT PRIMARY KEY, requests INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, in_tokens INTEGER NOT NULL DEFAULT 0, out_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0)"
   ```
5. Choose the model and caps in your private copy of
   `wrangler.production.example.jsonc`: keep `AI_MODEL` at `gpt-5-mini`
   or pick another model ID, and update `AI_INPUT_USD_PER_M` /
   `AI_OUTPUT_USD_PER_M` to that model's prices. Set `AI_DAILY_USD_LIMIT` and
   `AI_DRAFTS_PER_IP_DAY` to what you are willing to pay (USD 5 covers roughly
   2,000 or more drafts at gpt-5-mini prices).
6. Set `"AI_DRAFTING_ENABLED": "true"` and deploy.
7. Verify on the real hostname:
   - `GET /api/config` shows `"ai_drafting_enabled": true` and your
     `ai_provider_name`, and no key or model.
   - On a report, "Draft with AI" appears next to "Prepare email draft"; the
     consent screen names the provider; cancelling sends nothing (check the
     browser's network panel); confirming returns a draft labelled
     "AI draft — check every detail before sending".
   - The operator dashboard (`/admin`) shows today's AI draft count and
     estimated cost, and the provider console shows matching usage.
   - `npx wrangler d1 execute reputation_app_production --remote --command "SELECT * FROM ai_draft_usage"`
     shows only counters, and no table contains the draft text.
   - The eleventh draft from one network in a day is refused with the
     template fallback message.

To switch it off, set `AI_DRAFTING_ENABLED` back to `"false"` and deploy, or
delete the secret (`npx wrangler secret delete AI_API_KEY`); both fail closed.
Publish the privacy and terms updates listed for AI drafting before turning it
on.

## SearXNG hosting choices

**All compute on Cloudflare:** run the dedicated SearXNG image in Cloudflare
Containers, behind an authenticated Worker/container entry point. Containers
support Linux amd64 images and require Workers Paid. Pin a verified amd64
image; the VPS image ID is not a portable registry digest. Reapply the
existing single-engine, POST/JSON-only and no payload/access-log settings.
Use ephemeral storage for processing and no persistent query/result volume.

Validate the chosen upstream engine from that environment with a neutral
query before enabling public search. Successful VPS searches do not prove
Container searches will work: outbound networking, changed egress addresses,
engine blocking and cold starts need a staging check. A dedicated/static
IPv4 egress guarantee has not been verified. Start with enough memory for
SearXNG (the documented basic instance has 1 GiB) and measure startup and
concurrency against the app's 12-second provider timeout. Do not silently
fall back to an external paid provider or demo results on failure.

**Use the existing tested service while staging that move:** keep SearXNG on
the existing VPS, expose only its dedicated loopback port through Cloudflare
Tunnel, and protect the tunnel hostname with an Access **Service Auth** policy.
The Worker authenticates using the server-only Access headers. Keep the
SearXNG listener inaccessible from the public internet outside that protected
path. A tunnel is not authentication by itself. This option still uses VPS
compute, even though visitors connect through Cloudflare.

Neither option is newly provisioned here. The current localhost preview still
uses the existing SSH tunnel to the dedicated VPS instance.

## Privacy and hosted acceptance

Turnstile processes visitor IP/browser signals through Cloudflare. The app
sends only the challenge token and secret to Siteverify, not names, query
text, report IDs or contact fields. We supply the widget with its public site
key, a fixed action and display options; no application content is supplied.
The official script executes in the app page, so this is not a separate-origin
script sandbox. Local development does not load the external widget.

Keep API/search requests in POST bodies and responses `no-store`; explicitly
bypass edge caching for `/api/*` and private search routes. Do not enable
request-body capture, query logging, analytics on sensitive flows, or
cloudflared debug logs. Worker/container observability must remain explicitly
off. Cloudflare and upstream engines still process requests.

Deletion from active D1 quota tables is not immediate erasure from all
infrastructure: D1 Time Travel is always enabled (currently 7 days on Free,
30 on Paid), and Cloudflare Access/security products retain their own metadata.
No zero-retention promise is made. Establish a review/retention process for
deliberately submitted assistance before advertising a response service.

After the real database, gateway and keys are ready, verify on the actual
hostname: HTTPS, CSP and no-store headers; valid/invalid/expired bot checks;
fourth public scan and cooldown rejection; assistance limits; staff sign-in;
operator daily bypass with parallel-call limits; neutral live search and
engine failure; browser-only report persistence. Successful local tests or a
dry-run do not validate those hosted controls.

## Launch checklist

- [ ] Production D1 created, `schema.sql` applied (or the assistance migration
      above run), real `database_id` set.
- [ ] Secrets installed: `RATE_LIMIT_SECRET`, `OPERATOR_ACCESS_KEY`,
      `TURNSTILE_SECRET_KEY`, search gateway credentials.
- [ ] **Cloudflare Access with MFA on `/admin*` and `/api/operator/*`**
      (Zero Trust > Access > Applications > Self-hosted, hostname
      `app.123reputationmanagement.org`, paths `/admin*` and
      `/api/operator/*`, policy allowing named staff emails only, identity
      provider with MFA required). The public pages no longer link to
      `/admin`; it is reached directly. Confirm an unauthenticated browser
      gets the Access login page on both paths and that public pages and
      `/api/config`, `/api/search*` and `/api/assistance` stay reachable.
- [ ] Email Routing enabled on `notify.123reputationmanagement.org` only (root
      MX still 20i StackMail), `hello@123reputationmanagement.org` verified
      as destination, `send_email` binding and `ASSISTANCE_TO` /
      `ASSISTANCE_FROM` set; test request received.
- [ ] Response headers on the real hostname include HSTS, CSP,
      Permissions-Policy, COOP and `X-Robots-Tag`; `/robots.txt` is served.
- [ ] `workers_dev` and preview URLs remain disabled; observability off;
      `CLOUD_AI_ENABLED` stays `false`.
- [ ] AI drafting: either `AI_DRAFTING_ENABLED` stays `false`, or the
      `AI_API_KEY` secret is set, provider retention terms are confirmed,
      `ai_draft_usage` exists, caps are reviewed, the privacy notice and terms
      describe it, and the verification steps in the AI drafting section pass.
- [ ] `/privacy.html` and `/terms.html` reviewed for your deployment (they ship generic and operator-neutral).
- [ ] `SHOW_LIMIT` is `20` (the maximum the app accepts).
- [ ] Hosted acceptance checks in the section above completed.

## Primary references checked 25 September 2026

- [Send emails from Workers](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)
- [Email Routing destination addresses](https://developers.cloudflare.com/email-routing/setup/email-routing-addresses/)

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Worker Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Turnstile privacy](https://www.cloudflare.com/turnstile-privacy-policy/)
- [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/)
- [Containers lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/)
- [Container limits](https://developers.cloudflare.com/containers/platform/limits/)
- [Worker logging](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

## Partner and admin sign-in (Cloudflare Access)

Partners (NGOs, law firms, PR firms) sign in with an email one-time PIN. Access only proves the email address; the Worker verifies the signed Access token (`Cf-Access-Jwt-Assertion`) and checks the D1 `partners` table, which the admin manages on `/admin`. Each partner gets `PARTNER_DAILY_LIMIT` scans a day by default (50), counted per email. Partners skip the public bot check but keep the public per-scan query limit and the top-20 result limit.

Setup (Zero Trust, Free plan):
1. Add the **One-time PIN** login method.
2. Create a self-hosted application for `<app host>/api/partner/login`, with session duration 30 minutes and a policy that allows **Everyone**. The Worker decides who is a partner.
3. Create a self-hosted application covering `<app host>/admin*`, `/api/operator/login`, `/api/operator/usage` and `/api/operator/partners*`, with a policy that allows only the admin emails.
4. Put the team domain and both application audience tags in `ACCESS_TEAM_DOMAIN`, `ACCESS_PARTNER_AUD` and `ACCESS_ADMIN_AUD`, and set the same admin emails in `ADMIN_EMAILS`.
5. For a database created before 2026-10-05, apply `migrations/0002_partners.sql` once.

When `ACCESS_TEAM_DOMAIN` is set, admin routes need both the operator key session and a valid admin Access token. Partner sign-in stays unavailable until Access is configured.
