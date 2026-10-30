# Help links reviewed 24 September 2026

Contact details and eligibility wording were checked against primary sources:

- OSC reporting portal: linked from https://www.osc.gov.sg/
- SHECARES: https://www.she.org.sg/shecares-scwo and the operating update at https://www.she.org.sg/news/shecaresscwo-transitions-to-shecares-as-she-assumes-full-operations
- SOS: https://www.sos.org.sg/contact-us/
- Tinkle Friend: https://www.tinklefriend.sg/ (primary school children, 13 and below; helpline hours differ from online chat hours)
- Police: https://www.police.gov.sg/contact-us and https://www.police.gov.sg/SMS-70999
- StopNCII: https://stopncii.org/ and https://stopncii.org/faq/
- Take It Down: https://takeitdown.ncmec.org/faq/ (age when the image was taken determines eligibility; do not download material to use the service)

Run `npm run check-links` for current HTTP reachability. A valid link and a successful status check do not guarantee a particular request is eligible for removal.

SHECARES returned HTTP 500 when the request sent exactly `Accept: text/html`. Its deep link returned HTTP 200 with the browser-compatible Accept list used by the checker. No server errors are exempted.

Three legitimate automated-access restrictions were verified and recorded with status/header checks and a 24 December 2026 review expiry in `check-links.mjs`:

- X Help forms: HTTP 403 with `cf-mitigated: challenge`; the same official page is accessible through web search and lists reporting categories.
- Glassdoor Help Center: HTTP 403 with `cf-mitigated: challenge`; https://www.glassdoor.com/blog/responding-to-negative-glassdoor-reviews-faqs/ links to the Help Center and explains flagging reviews.
- Cloudflare abuse form: HTTP 403 with Cloudflare's “Attention Required” security-block page; https://developers.cloudflare.com/fundamentals/reference/report-abuse/submit-report/ (updated 10 September 2026) confirms the public form, and the web search tool could retrieve its title/form text.

The checker prints these as REVIEWED, not HTTP 200, and will fail on unexpected statuses, headers or expired reviews. No network/DNS failures or HTTP 500s are exempted.
