# Reporting coverage and automatic routing

The app accepts known HTTP(S) content URLs across platforms, including adult websites. Acceptance into the workflow is not a guarantee that a contact will be found, a form can be submitted automatically, the origin host can be identified, or content will be removed.

## Route selection

1. Use a curated official platform route when present. Email destinations are filled automatically. Platform forms take precedence over guessed email addresses.
2. For unlisted domains, opening the request automatically shares only its hostname with `/api/reporting-contact`. The server uses Cloudflare DNS-over-HTTPS and public RDAP registration records. Registry endpoints are selected directly from IANA bootstrap data; redirects to endpoints outside that directory are blocked. No reported page or media is fetched.
3. Return only role-qualified abuse contacts, labelled separately as network operator, CDN, or domain registrar. Select the first available escalation route and offer alternatives when available. These are not assumed to be the publisher or origin host. Cloudflare uses its reporting form.
4. If lookup is unavailable or finds no usable contact, show **needs investigation** and a help route. Do not invent abuse@ addresses or claim complete coverage.

The report supports connected-account sending after user review, subject to Gmail/Outlook configuration. The known-URL queue offers platform forms and opens an email draft to discovered escalation contacts in the user’s email app. These are different submission paths; neither automatically submits forms or claims removal.

## Adult platforms and intimate-content reports

Known URLs are handled without downloading imagery. Added curated known-URL routes for Tumblr, Telegram and Pornhub alongside the existing social-platform routes. Other adult domains use the same public-metadata fallback as any other unlisted domain. The app does not search for or fetch intimate content. Existing under-18/uncertain-age specialist-support routing remains in place.

Route references checked 28 September 2026:

- [Telegram FAQ](https://telegram.org/faq): public-content abuse reporting and copyright contacts; its specialist NCII reporting guidance is linked in the known-URL queue.
- [Tumblr reporting guide](https://help.tumblr.com/knowledge-base/reporting-content/): official abuse form and in-app reporting.
- [Canada Privacy Commissioner’s Pornhub investigation](https://www.priv.gc.ca/en/opc-actions-and-decisions/investigations/investigations-into-businesses/2024/pipeda-2024-001/): content-removal process. The current form could not be opened by the research tool; regional availability and any verification requirements must be checked by the user directly.
- [IANA RDAP bootstrap data](https://data.iana.org/rdap/), [Cloudflare DNS JSON API](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/).

## Limits and privacy

- DNS, RDAP and platform directories are incomplete and can change. The current network lookup uses IPv4 A records; IPv6-only sites, private/onion services, hidden origins, registry omissions, rate limits and regional blocks may require investigation.
- A shared host, CDN, IP network owner, registrar and publisher are different roles. Registration-domain parsing is conservative and not a complete public-suffix implementation; a returned contact is an escalation candidate, not proof of control over content.
- Only the hostname is shared for lookup. Full reported paths, query strings, names, drafts, images and case IDs stay out of this endpoint. Hostnames can still be sensitive; the interface discloses the domain-only lookup.
- Results are held in memory for the current page session. The server retains short-lived keyed rate counters, not lookup reports. Providers process the hostname/IP query; provider infrastructure may retain metadata.
- Sending a complaint remains an explicit user decision. There is no bulk automatic emailing, automatic form submission, or promise that every provider accepts an email.

## Validation

Automated tests cover strict hostname-only input, private target rejection, registry allowlisting, untrusted redirects, role-qualified contacts, CDN labels, unresolved results, platform lookalikes, source provenance and browser draft flow. A neutral live `example.com` lookup reached authoritative registry data and returned the Cloudflare escalation form. No victim URL or media was fetched and no complaint was sent.
