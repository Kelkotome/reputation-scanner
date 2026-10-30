# End-to-end flow audit — 30 September 2026

## Verdict

The browser workflow is usable for preparing and tracking requests. It is not yet a fully live removal service: real mailbox authorization/sending and unattended hosted execution remain unverified because provider credentials are absent. A request being sent, accepted, or marked removed is not independent proof that the content was removed.

## Gaps found and fixed

| Priority | Gap / reproduction | Improvement |
| --- | --- | --- |
| High | A built-in known-URL demo was identified only by `demo=1` in the URL. Reopening without it or exporting could lose the fictional-data warning. Editing demo input also cleared the flag. | Persist demo status; recognise the exact legacy fixture; retain demo mode through edits; label exports and disable connected sending for demo cases. |
| High | Losing the email cookie hid server-side follow-ups. Signing into the same mailbox previously created a separate session and could leave the old queue active. | Keyed mailbox ownership established only after successful provider authentication. Same-mailbox reauthentication recovers retained history and cancels previous queued jobs as disclosed. Another mailbox cannot access that history. Recovery controls are on the dashboard. |
| High | A manually sent follow-up could coexist with the original automatic queue and result in a duplicate later. | Before connected manual follow-up sending, and when recording a manually sent follow-up, stop the matching queued automatic job. Cancellation failure is surfaced rather than silently ignored. |
| High | An initial-send response lost in transit could leave a server queue without a local marker, making closure unable to find it. | Save the intended follow-up marker and request ID before sending. Dashboard reconciliation restores the initial accepted outcome from server follow-up metadata. |
| Medium | Reports could export an old status after the case changed in another tab. Old email statuses could appear current. | Reload the record and check email status immediately before export/print. Fail if the record disappeared or selection changed. Reports clearly label unverified/stale email status and local logs. |
| Medium | Outcome changes had no dated history; scan manual-send state had little chronology. | Keep up to 250 recent status changes per item and include dated, explicitly local status entries in exports. Historical changes cannot be reconstructed retroactively. |
| Medium | Deleting cases or clearing browser records left report notes and identifying email-receipt metadata behind. | Remove notes and identifying receipt fields after cancelling relevant queues. Keep only request ID/status under the existing message hash for duplicate protection. |
| Medium | A localhost connection could offer an automatic schedule even though local cron never runs automatically. | Reject new automatic schedules in local-development mode and show the limitation in the connected-account UI. Initial sending remains available once credentials are configured. |

## Verification performed

- Created a fictional known-URL queue through the UI, reviewed the unlisted-domain draft, recorded a simulated manual send, and verified a reminder exactly 14 days later. No email was sent.
- Reopened the fixture without its demo URL flag: the warning remained after the fix.
- Opened the case in the report dashboard, changed its outcome in the case tab, then downloaded the report: the exported preview picked up `removed` rather than the stale `sent` value.
- Checked police and PR versions: demo watermark, reporter details, user-recorded chronology and redacted PR content behave as intended. No browser console errors in the exercised dashboard path.
- Full automated regression: 678 tests / 35 files passed. After the final status-history, cleanup and local-scheduling changes, 163 focused tests / 6 files passed. Email providers are mocked, including lost-cookie recovery, wrong-mailbox isolation, time-boundary sending, duplicate reservations, timeout handling, cancellation and refresh failure.
- Existing scan pipeline, search consent and source routing are covered by the browser API/scan and provider regression suites. A browser walkthrough of the saved fictional scan confirmed exactly ten visible cards, ten additional domain previews and the contact-us step. A new live personal search was not performed.
- PDF uses the native print dialog; actual saved PDF pagination remains unverified. HTML download and on-page report content were exercised.
- Final additional regression: 30 tests passed, including demo identity/status-history export and privacy cleanup. The local status endpoint still reports both mailbox providers unconfigured.

## Remaining launch requirements and product limitations

1. **Real sending and background operations:** configure Gmail/Outlook OAuth, deploy to an always-on HTTPS Worker/D1 with cron, and test a controlled mailbox through initial send, cancellation, reply recording and follow-up delivery. Production OAuth grants must remain valid beyond day fourteen. No real mailbox was connected in this audit.
2. **Coverage and outcomes:** public search does not cover every site, private Telegram group, login-only page or unindexed post. Domain/registration contacts can be infrastructure escalation destinations, not the publisher or origin host. Forms still require manual submission. Never advertise guaranteed universal discovery or removal.
3. **Reply detection and escalation:** no inbox access means the user must record replies. Failed/revoked/ambiguous jobs require dashboard review; there is no outbound failure notification channel or staffed escalation SLA.
4. **Case continuity and evidence:** case contents and notes remain in this browser; there is no cross-device account sync or full restorable case backup. Export summaries before clearing browser storage. Reports do not include authenticated source captures, message originals, or attached evidence and are not official police filings. Preserve supporting originals separately.
5. **Contact-us operations:** assistance requests are saved for review, but there is no complete staff case-management or partner-delivery workflow. This needs an operational owner before promising a response time for additional results or removal assistance.

Fictional QA record retained for reproduction: `2a762dff-f025-422a-ab13-ad52bbc21a3a`. It is visibly labelled as demo data and was not submitted to any external recipient.
