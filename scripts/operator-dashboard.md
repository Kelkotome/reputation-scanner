# Operator dashboard and public quota

The local dashboard is at `http://localhost:8787/admin`. Use the value of
`OPERATOR_ACCESS_KEY` in the private `.env` to sign in. Do not paste the key
into a URL, commit it, put it in public assets or send it to a visitor.

The owner authorised unlimited **daily operator scans** and three public
scans per IP per UTC day. A scan is one bounded set of search queries, not one
provider HTTP call. Operators still use finite query plans, timeouts and the
same sensitive-content restrictions. Search engines may impose their own
rate limits; operator access cannot override those.

## Setup

- `OPERATOR_ACCESS_KEY`: a private random value of at least 32 characters.
- `RATE_LIMIT_SECRET`: a distinct random value of at least 32 characters,
  used for keyed quota identifiers. Never ship it to browsers.
- `LOCAL_DEVELOPMENT=true`: only in the local `.env`. Exact loopback preview
  hosts use a fixed local IP identity and ignore forwarded IP headers.
  Hosted deployments must keep this false and run behind the trusted
  Cloudflare edge. Do not trust caller-supplied forwarding headers on an
  arbitrary reverse proxy.

Both secrets were generated locally without displaying their values in the
task output. Existing provider keys were preserved. The local `.env` is
owner-readable/writable only. Public deployment still needs explicit secret
installation and a protected search gateway; nothing here publishes the app.

Use `npm run dev:live` with the SearXNG SSH tunnel running. Schema setup is
additive and does not migrate, read or purge old scan/case tables.

## Metering scope

The dashboard shows today's and the last 30 UTC days' aggregate activity,
separated into public and operator usage. Search cost is a configured
per-request estimate, including failed provider attempts, not a vendor invoice.
SearXNG has no per-query API charge in this configuration; the VPS cost is
separate. Estimates do not include other projects or externally incurred costs.

Cloud AI remains disabled. Input/output tokens and AI token cost are zero for
this active application. This dashboard does not call OpenAI billing APIs,
read keys from other projects, or send scan content to a model. Earlier
unsegmented counters are not retroactively attributed to a provider or operator.

## Privacy and quota behavior

Only short-lived quota/session metadata and aggregate usage reach the server
database. Names, search text, result URLs/snippets, reports, drafts and reminder
records remain browser-owned. Explicit assistance submissions remain separate.

An opaque scan permit bounds the number of provider requests available to one
scan. Public permit creation is limited atomically to three starts per IP/day;
retries with the same request nonce are idempotent. A request nonce is randomly
generated separately from the browser's record ID. Permits are bound to the
current day, provider and caller. Operator permits require a valid session and
do not consume the public allowance or daily search/spend budget.

The daily counter resets at 00:00 UTC, or 08:00 Singapore time. Shared networks
share an allowance; changing IPs can change it. Local deletion or clearing
cookies does not reset the server quota. If a permit expires while a scan is
unfinished, continuing requires a fresh permit and may use a new daily slot.

Keyed IP identifiers change daily. Expired quota/login/session metadata is
removed by request-time cleanup and the configured hourly Worker scheduled
handler; deployment must enable that schedule. These are operational counters,
not an anonymous guarantee or a record of what a visitor searched for.

Operator sessions use HttpOnly, SameSite=Strict cookies; production HTTPS
cookies are Secure. The login key is cleared from the form after submission
and is not placed in localStorage/sessionStorage. Sign out to revoke the
current session. Signing out preserves local reports; larger unfinished
operator scans require signing in again to continue.

## Cloudflare abuse protection update

The confirmed hosted app is `app.123reputationmanagement.org`; see
`deploy/cloudflare/README.md`. Public new starts have a 60-second cooldown.
Operators still have no daily cap, with a 30-new-starts/minute burst limit and
four simultaneous provider calls per session (six globally). These controls
protect capacity without changing daily access. Contact submissions have an
IP-based hourly limit for both audiences.

The localhost preview skips external Turnstile only through the explicit
loopback development settings. Hosted bot checks require real widget keys and
hostname validation. Staff Access/MFA and cloud deployment remain separate
provisioning steps. Cleanup removes active metadata; hosted D1 backups have
separate retention and are not an immediate secure-erasure mechanism.
