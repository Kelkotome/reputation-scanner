# URL-only takedown channel review — 24 September 2026

This feature stores user-supplied URLs and reporting metadata. It does not visit source pages, fetch headers, resolve URL shorteners, classify images, load thumbnails, accept files, use an AI provider or send requests. Routing is an exact host/suffix match against the registry, not verification of what a URL contains.

The user selected manual review/submission and local reminders. A 14-day due timestamp is created only when the user records an actual submission. The dashboard checks due dates while open; it does not run a background sender or notify when the app is closed. This is an administrative schedule, not a legal removal deadline. Removed, refused and escalated reports stop reminders. Recording the follow-up clears its due state without creating a repeat schedule.

## Verified general channels

- Reddit: [general reporting form](https://support.reddithelp.com/hc/en-us/requests/new?tf_15968861076756=report_content_policy_violation&ticket_form_id=15968767746196). [Policy](https://support.reddithelp.com/hc/en-us/articles/360043513411-Never-Post-Intimate-or-Sexually-Explicit-Media-of-Someone-Without-Their-Consent) permits reports by the depicted person or their representative.
- Facebook, Instagram and Threads: [Meta NCII reporting guidance](https://www.meta.com/safety/topics/bullying-harassment/ncii/). [Meta help](https://www.meta.com/help/policies/1437976901029950/) describes authorised representatives and specialised forms, but their availability and sign-in/region conditions vary. Use general guidance as the default for Singapore; do not present a US-specific form as universally available.
- X: [private-information form](https://help.x.com/en/forms/safety-and-sensitive-content/private-information). [Intimate-media policy](https://help.x.com/en/rules-and-policies/intimate-media) accepts authorised representatives. Submit verification directly to X.
- TikTok: [privacy reporting route](https://www.tiktok.com/legal/report/privacy?lang=en), linked from [its safety policy](https://www.tiktok.com/community-guidelines/en/safety-civility?cgversion=2025H2update). Follow live form eligibility and evidence requirements.
- Google Search: [personal-content removal guidance](https://support.google.com/websearch/answer/16305143) and [form](https://support.google.com/websearch/contact/content_removal_form?hl=en). This is separate from source-site removal. Authorised representatives are supported, and some branches request further evidence.
- Singapore OSC: [intimate-image reporting and eligibility](https://www.osc.gov.sg/what-you-can-report/intimate-image-abuse/) and [official reporting portal](https://report.osc.gov.sg/). Eligible people may report directly without waiting 14 days. Authorised representatives supply the signed authorisation and identity proof directly to OSC. URLs alone may not meet every evidence requirement.
- [StopNCII](https://stopncii.org/) handles qualifying adult-image hashes locally on the affected person's device. Our app never handles those files.

No reviewed source establishes a universal public API or email endpoint for automatic submissions. Unknown domains remain labelled as lacking a verified route. The app never constructs an abuse email address from a domain.

## Timing and liability limits

[FTC guidance](https://www.ftc.gov/business-guidance/resources/complying-take-it-down-act) describes a 48-hour removal requirement after a valid notice under the US TAKE IT DOWN Act for covered platforms. Eligibility, notice contents and the designated reporting process matter; do not apply it automatically to every website worldwide. The MVP's 14-day reminder is not a statement about that deadline.

Not storing media reduces media handling but does not establish immunity from liability. Reporter details and associated URLs may still be personal data. [Singapore PDPC obligations](https://www.pdpc.gov.sg/overview-of-pdpa/the-legislation/personal-data-protection-act/data-protection-obligations) include appropriate purposes, protection, retention and consent requirements. Checkbox declarations record the reporter's assertion; the app does not verify identity, authority or whether the URL contains unlawful content. Obtain legal review of the operating process before offering this as a public service.

For images created when the person was under 18, or age is uncertain, the MVP gives specialist reporting routes without storing the submitted case or drafting a report. Do not download or forward imagery to use the app.
