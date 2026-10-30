# 123 Reputation Management — MVP brand notes

This MVP uses the existing 123 Reputation Management website theme as its brand source: the separate website theme project (`theme/rm123`, not included in this repository). Its `assets/css/main.css` defines the palette and typography. The designer-supplied logo files now replace the original theme logo. The supplied localhost:8123 screenshot is the original visual reference. The shared footer now follows the live https://123reputationmanagement.org/ footer checked on 24 September 2026.

## Logo and site placement

The owner supplied two 1080 × 1080 PNG presentation sheets (source sheets kept outside this repository):

- `123 LOGO 2.png`: navy/gold shield, wordmark and tagline.
- `123 LOGO 2.1.png`: black/white variants.

Both files are copied unchanged into `public/assets/`. The header arranges the original colour shield and wordmark in a compact horizontal layout using inline SVG viewports. The footer arranges the supplied white shield and wordmark in a compact horizontal lockup using SVG viewports and lighten blending against navy. No artwork is redrawn, recoloured, stretched or sent to an external image service. The tagline is omitted from compact navigation. The favicon uses an embedded copy of the supplied monochrome shield, so it has no external image dependency. The accessible home link names the full company; decorative logo artwork is hidden from assistive technology.

The original PNGs include opaque presentation backgrounds. Use designer-provided transparent/SVG exports if supplied later; do not replace the artwork with an approximation.

The MVP is intended for a dedicated subdomain of the 123 Reputation Management website. The exact hostname is not yet specified. This remains a local preview; no domain, DNS, hosting or public deployment has been configured. Toolkit navigation, assets and API calls use same-origin paths. Corporate footer navigation uses absolute HTTPS links to https://123reputationmanagement.org/ so services, resources and legal pages work from the eventual subdomain.

## Shared foundation

| Role | Value |
| --- | --- |
| Navy / secondary navy | `#0b1b2b` / `#1e3246` |
| Teal / dark teal | `#0f6b5c` / `#0a5044` |
| Pale teal | `#e6f2ee` |
| Gold accent | `#f2b705` |
| Canvas / paper | `#f6f6f2` / `#ffffff` |
| Body / muted / borders | `#334155` / `#64748b` / `#e3e6ea` |
| Typeface | Inter Tight variable, served locally |

Use navy headings, warm neutral backgrounds, teal supporting details, pill buttons and rounded white cards. Reserve gold for key actions and brand details; pair gold with navy text. Semantic warning/error colours remain distinct from decorative accents. Preserve visible focus, disabled states, native form labels, readable small text and reduced-motion support.

The header, footer and favicon use the supplied shield artwork and wordmark across all five pages. `public/assets/fonts/OFL.txt` accompanies the copied font. No font CDN, tracker, remote icon library or image service was added.

## Product application

The same theme covers individual/business intake, reports and draft dialogs, known-URL intake/queue, safety resources and explicit assistance. Preserve form hooks, consent/accuracy controls, saved-record lists, deletion actions and attachment previews when changing styling.

This is a free self-help toolkit. Do not copy the marketing site's illustrative review ratings or other example metrics into real reports. Keep demo results labelled fictional. Do not promise removal, verified identity or legal outcomes.

Scans, cases, drafts and reminders are saved in this browser profile's IndexedDB. The active worker does not load old server records. Live search is paused with `ALLOW_SEARCH_RELAY=false` pending the owner's relay/provider-processing decision. No cloud AI, source-page/media fetching or RDAP lookup is active. Assistance is the separate explicit sharing action; report attachments require opt-in and preview. Styling must not obscure these boundaries, storage failures, manual review or 14-day reminders.

Browser-local records are not synced, encrypted by this app or recoverable from its server. Anyone using the same profile may access them. The quick-exit button has been removed. Navigating away does not delete IndexedDB records, history or clipboard contents. Keep record deletion and clear-all separate. Local deletion does not withdraw assistance or reports already sent elsewhere.

## Corporate footer

All five pages share the live site's Services, Industries, Resources and Company columns, brand description, copyright and Privacy Policy/Terms links. The footer uses the main site's `#07131f` background, muted text, five-column desktop grid and two-column mobile navigation. It retains the designer-supplied shield instead of the main site's older placeholder symbol. The logo images and fonts remain local.

Existing toolkit-specific notes and local Safety & support/Ask for help links sit immediately before the footer. Corporate links have a no-referrer policy and carry no scan or case identifiers. No corporate scripts, analytics, tracking or runtime HTML fetching are included. The pre-footer audit marketing banner is not part of this footer change.
