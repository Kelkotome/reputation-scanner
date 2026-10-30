# Follow-ups and case reports

Open `/dashboard.html` using the same origin and browser profile as the saved cases. Choose a scan or known-URL removal case. Add the reporter's account and references to supporting material, select Police, Law firm or PR, then use **Print / save PDF** or **Download branded HTML**. The HTML embeds the existing logo and stylesheet and works offline. There is no automatic submission to police, a law firm or a PR agency.

Police and law-firm versions include available URLs, reporter details, factual narrative, references and action history. The PR version omits names, emails, titles, full URLs and free-text notes; domains can still be sensitive and should be reviewed. Scan exports include at most the first ten priority links. Known-URL cases include the URLs the reporter supplied. No source pages or images are downloaded or verified. Fixture data is prominently labelled. The report is a supporting summary, not an official police report or proof of an offence.

## Scheduling

1. In a request draft, choose the optional 30-day connection checkbox before connecting Gmail or Outlook. A normal connection still expires within an hour.
2. Review the initial email and opt into the single 14-day follow-up. Both messages and the recipient are approved together when **Send email now** is pressed.
3. Only provider acceptance of the initial email activates the queue. Its timestamp plus exactly fourteen 24-hour days sets the due time. The hosted hourly cron sends at or after that time.
4. In the dashboard, record a reply, close the request or cancel the follow-up to stop a queued send. Inbox access is not requested: replies are not detected automatically. Closing a local item also attempts to cancel its matching queued follow-ups. A send already in flight cannot be recalled.

Official forms and messages opened in an external email app retain manual reminder behaviour: their submission cannot be verified by this integration. A manually sent follow-up is not scheduled for another follow-up. Direct sending is disabled for demo fixtures.

Approved follow-up content and offline credentials are encrypted with AES-GCM and context binding. Jobs are bound to their email session, not public case identifiers. The server receives no scan/case ID. Tokens and jobs expire after at most 30 days; follow-up bodies are erased after cancellation or submission. Disconnecting or reconnecting cancels queued jobs for the previous connection. Browser receipts keep request IDs, recipient, subject and timestamps for report generation; report notes stay local. Provider credentials never enter browser JavaScript. Clearing cookies may lose management access; use the provider's account settings to revoke the app if necessary.

Cron uses atomic claims and a final submission reservation. It never automatically retries an uncertain provider result. Token failures and schedules more than two days overdue become `needs_attention`, requiring review rather than an unexpected late send. Crashed reservations become `unknown`. Check Sent mail before a new manual attempt. Repeated requests with the same session/request ID are deduplicated, but a deliberately new request is not an exactly-once delivery guarantee. Up to 25 jobs are processed per hourly invocation.

## Deployment prerequisites

- Configure provider credentials using `EMAIL-CONNECTION-SETUP.md`; they are not supplied by this implementation.
- Deploy the Worker to an always-on HTTPS origin, set secrets, apply `schema.sql` to the intended D1 database and enable the hourly cron in `wrangler.jsonc`.
- Google offline access uses `access_type=offline`; Microsoft requests `offline_access`. Production OAuth approval matters: Google testing grants for non-basic scopes can expire before fourteen days. Do not advertise automatic follow-ups until production grants and a controlled mailbox test have been validated.
- Local Wrangler does not trigger cron automatically. Automated tests simulate the fourteen-day passage with mocked providers; no real email was sent during development.

References: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Microsoft authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).

## Audit hardening

Fresh provider sign-in to the same mailbox now recovers retained follow-up history even after cookie loss, and cancels earlier queued jobs. Ownership uses a keyed mailbox fingerprint retained only while its session or follow-up records exist. Dashboard recovery buttons also work without any locally saved case. Local-development mode rejects new automatic schedules rather than presenting them as active.

Demo identity survives reopening and export. Manual follow-ups cancel their corresponding automatic queue. Exports reload the latest case and disclose stale/unverified email status; dated local status changes are retained for new actions. Case deletion removes report notes and identifying receipt metadata while preserving a minimal duplicate-send guard. See `FLOW-AUDIT.md` for verification scope and remaining launch requirements.
