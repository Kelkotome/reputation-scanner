# Connect Gmail and Outlook

The report’s removal-request dialog supports optional Gmail and Outlook connections, a final review showing From/To/subject/body, and an explicit **Send email now** button. Draft previews still work without email. The integration is implemented, but real account authorization and sending require your provider credentials. Do not paste secrets into chat or public files.

## Local configuration

Run `node scripts/setup-email.mjs` once. It preserves existing settings, generates a separate encryption key in the ignored `.env`, and adds empty provider settings. Then fill these privately:

```dotenv
EMAIL_APP_ORIGIN=http://127.0.0.1:8788
EMAIL_TOKEN_KEY=<generated 64-character hex key; keep private>
GOOGLE_CLIENT_ID=<web application client ID>
GOOGLE_CLIENT_SECRET=<client secret>
MICROSOFT_CLIENT_ID=<application client ID>
MICROSOFT_CLIENT_SECRET=<client secret value, not its ID>
```

Either provider can be configured independently. Restart `npm run dev:live` after editing `.env`; it applies the additive schema and rebuilds the browser bundle. Use the exact configured app origin: cookies and browser reports are origin-specific. Do not switch between localhost and 127.0.0.1.

## Google

1. Create/select your Google Cloud project and enable **Gmail API**.
2. Configure the OAuth consent screen, app identity, support email, and audience. For testing, add your own account as a test user.
3. Create an OAuth client of type **Web application**.
4. Register this exact authorized redirect URI: `http://127.0.0.1:8788/api/email/callback/gmail`.
5. Configure the client ID and secret privately. Requested scopes are `https://www.googleapis.com/auth/userinfo.email` and `https://www.googleapis.com/auth/gmail.send`.
6. For public release, complete Google’s applicable consent-screen and scope verification requirements. Testing access is not equivalent to production approval.

References: [Google web server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Gmail send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send).

## Microsoft

1. Register an app in Microsoft Entra. To support Outlook.com and organizational accounts, select accounts in any organizational directory and personal Microsoft accounts.
2. Add a **Web** redirect URI: `http://127.0.0.1:8788/api/email/callback/outlook`. Microsoft may require adding an HTTP IP-loopback URI through the app manifest rather than the portal URI field; follow its current redirect-URI guidance. Keep the origin consistent with the local report.
3. Add Microsoft Graph **delegated** permissions `User.Read` and `Mail.Send`. Do not use application-wide sending permission.
4. Create a client secret and save its **value** privately in `.env` with the application client ID. Track its expiry.
5. Organizational administrators may need to approve consent under their tenant policy. The connected account needs a supported mailbox.

References: [Microsoft authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [redirect URI restrictions](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url), [Graph sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0).

## Sending and privacy

- The entered contact email is the requested sender. Consumer Gmail/Outlook addresses suggest their provider; custom business addresses require the user to choose their actual mailbox host. Both OAuth completion and sending reject a different connected address.
- Other providers can use **Open draft in email app** or download an unsent `.eml` after reviewing the draft. The user must select the correct sender and send in their email app. Opening/downloading a draft never records a successful send and does not enable automatic follow-ups. Platform-specific reporting forms still take precedence where email is unsupported.

- Click Connect, complete provider authorization, return to the report. No message is sent during connection. The account address and expiry are shown.
- Set a contact email, prepare the draft, replace every placeholder, and verify the recipient against the publisher’s official channel. A generic address is never guessed.
- Review the accuracy checkbox, choose **Review & send**, then confirm the exact From, To, subject and message. A connected-account change invalidates the send.
- Provider acceptance updates the local report to sent. It is not proof of delivery, response or removal. Optional approved follow-ups are queued for 14 days later. There is no inbox reading: record replies and cancel queued follow-ups in the Case dashboard.
- Access tokens and account addresses are AES-GCM encrypted in D1, normally limited to one hour or the token’s shorter lifetime. An optional offline connection retains encrypted refresh access for up to 30 days. Reconnect or disconnect cancels existing queued follow-ups. Tokens are never sent to browser JavaScript or stored in browser storage.
- OAuth state is browser-bound, expires after ten minutes, and is consumed once. Both providers use authorization-code flow with PKCE. Mutation routes require exact same-origin JSON requests; callback redirects use state checks.
- Initial messages pass through the server only after confirmation. An explicitly approved follow-up is encrypted until it is submitted, cancelled or expires (at most 30 days). A session-bound message hash, random request ID, and send outcome are retained for up to 24 hours for duplicate protection. The browser retains hashes, recipients, subjects, timestamps and outcomes in localStorage; it already stores editable drafts in IndexedDB.
- Provider timeouts are ambiguous: check Sent mail. The app does not automatically resend unknown or rejected submissions. Clearing site data removes browser duplicate protection. A new session or deliberately changed message is not a provider-wide exactly-once guarantee.
- Up to 25 send submissions per connected session; ten connection starts per minute per keyed IP. Disconnect deletes server-held access and cancels pending authorization. Remove the app grant in Google/Microsoft account settings to revoke provider-level permission too.
- Expired rows are deleted by the hourly cleanup in hosted mode and when starting a connection. Local scheduled cleanup does not run automatically; expired sessions are rejected even before deletion. Infrastructure backups and providers may retain data beyond active-table cleanup.

## Hosting and verification

For a hosted site, use its exact HTTPS origin and register both HTTPS callbacks. Store encryption key and client secrets with the hosting secret mechanism, never in public assets or committed config. Apply `schema.sql` to the intended D1 database before enabling email. Publish updated privacy disclosures and complete provider approval before broad release. Worker payload logging must stay disabled.

Automated tests use simulated providers. Live OAuth consent and a real mailbox send remain unverified until credentials are configured. The development work does not send email on the user’s behalf.

See [FOLLOWUPS-AND-REPORTS.md](FOLLOWUPS-AND-REPORTS.md) for scheduling, cancellation, retention and report exports. Production OAuth setup is necessary: Google testing grants may expire before the fourteen-day due time.
