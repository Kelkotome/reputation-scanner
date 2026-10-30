// Curated removal channels for reputation issues. Big platforms need their own forms, not email.
// Run `npm run check-links` to confirm every URL still resolves.

import { registrableDomain, hostOf } from './text.js';

const TELEGRAM = { name: 'Telegram', email: 'abuse@telegram.org', source: 'https://telegram.org/faq', verified_on: '2026-09-28',
  how: 'Telegram publishes this address for reporting potentially illegal public content. Include the exact public message link and explain the concern. You can also use Report in Telegram. Removal is subject to Telegram’s review.' };

export const GOOGLE_CHANNELS = {
  personal_info: { label: 'Google: remove results showing your personal info', url: 'https://support.google.com/websearch/answer/9673730' },
  legal: { label: 'Google: legal removal request (defamation, copyright)', url: 'https://reportcontent.google.com/' },
  outdated: { label: 'Google: refresh outdated result (page already changed or deleted)', url: 'https://search.google.com/search-console/remove-outdated-content' },
};

/** Keyed by registrable domain. `form` = web form, `email` = abuse inbox, `how` = one-line instruction. */
export const PLATFORMS = {
  't.me': TELEGRAM,
  'telegram.me': TELEGRAM,
  'telegram.org': TELEGRAM,
  'tumblr.com': { name: 'Tumblr', form: 'https://www.tumblr.com/abuse', source: 'https://help.tumblr.com/knowledge-base/reporting-content/', verified_on: '2026-09-28',
    how: 'Tumblr directs content reports to its abuse form or Report menu. Choose the relevant issue and include the exact post URL. Use the form rather than a guessed email address.' },
  'reddit.com': { name: 'Reddit', form: 'https://www.reddit.com/report', how: 'Use Report on the post, or the Reddit report form for privacy and harassment.' },
  'hardwarezone.com.sg': { name: 'HardwareZone Forums', how: 'Use the Report button under the post and explain the concern for a moderator to review.' },
  'facebook.com': { name: 'Facebook', form: 'https://www.facebook.com/help', how: 'Open the ··· menu on the post and choose Report. Use the Help Centre for privacy or defamation forms.' },
  'instagram.com': { name: 'Instagram', form: 'https://help.instagram.com', how: 'Open the ··· menu on the post and choose Report.' },
  'x.com': { name: 'X (Twitter)', form: 'https://help.x.com/en/forms', how: 'Report the post, or use X Help forms for private information and abuse.' },
  'twitter.com': { name: 'X (Twitter)', form: 'https://help.x.com/en/forms', how: 'Report the post, or use X Help forms for private information and abuse.' },
  'tiktok.com': { name: 'TikTok', form: 'https://www.tiktok.com/legal/report', how: 'Report the video in-app, or use the TikTok legal report form.' },
  'youtube.com': { name: 'YouTube', form: 'https://www.youtube.com/reportabuse', how: 'Use YouTube reporting and the privacy complaint process.' },
  'linkedin.com': { name: 'LinkedIn', form: 'https://www.linkedin.com/help/linkedin', how: 'Report the post or profile from the ··· menu.' },
  'glassdoor.com': { name: 'Glassdoor', form: 'https://help.glassdoor.com', how: 'Flag the review as violating Community Guidelines.' },
  'trustpilot.com': { name: 'Trustpilot', form: 'https://support.trustpilot.com', how: 'Report the review from the review page (flag icon).' },
  'google.com': { name: 'Google', form: 'https://reportcontent.google.com/', how: 'For Maps reviews, flag the review; for other Google products use the report content tool.' },
};

export function platformFor(url, { template } = {}) {
  const host = hostOf(url);
  const reg = registrableDomain(host);
  const channel = PLATFORMS[host] || PLATFORMS[reg] || null;
  if (channel === TELEGRAM && template === 'copyright') return { ...TELEGRAM, email: 'dmca@telegram.org',
    how: 'Telegram publishes this address for copyright complaints about public content. Identify the copyrighted work and the exact public message link. Use this only if you own the work or are authorised to act for its owner.' };
  return channel;
}

/** Which Google de-index route fits a harm category (secondary channel for every hit). */
export function googleChannelFor(category) {
  if (category === 'doxxing_personal_info') return GOOGLE_CHANNELS.personal_info;
  if (['defamation_accusation', 'scam_fraud', 'crime_legal', 'harassment'].includes(category)) return GOOGLE_CHANNELS.legal;
  return GOOGLE_CHANNELS.outdated;
}

export const HELP_LINKS = [
  { name: 'Online Safety Commission (report online harm)', url: 'https://report.osc.gov.sg' },
  { name: 'SHECARES: help reporting online harm', detail: 'Call 800 101 4616 · WhatsApp 8985 5528 · Mon–Fri 9am–9pm, excluding public holidays', url: 'https://www.she.org.sg/shecares-scwo/' },
  { name: 'Samaritans of Singapore (24 hours)', detail: 'Call 1767 · WhatsApp 9151 1767', url: 'https://www.sos.org.sg/contact-us/' },
  { name: 'Tinkle Friend (primary school children, 13 and below)', detail: 'Call 1800 2744 788 · Mon–Fri 2.30pm–5pm, excluding public holidays', url: 'https://www.tinklefriend.sg/' },
  { name: 'Police', detail: 'Emergency 999 · SMS 70999 if it is unsafe to call or you cannot speak', url: 'https://www.police.gov.sg/contact-us' },
  { name: 'StopNCII (adults)', detail: 'For intimate images taken when you were 18 or older. Works with participating platforms; check the service’s eligibility guidance.', url: 'https://stopncii.org/' },
  { name: 'Take It Down (images taken when under 18)', detail: 'Can help even if you are now an adult. Do not download or share images to use the service; use only files already on your device.', url: 'https://takeitdown.ncmec.org/' },
];

export function allLinks() {
  return [...new Set([
    ...Object.values(GOOGLE_CHANNELS).map((c) => c.url),
    ...Object.values(PLATFORMS).map((p) => p.form).filter(Boolean),
    ...HELP_LINKS.map((h) => h.url).filter(Boolean),
    'https://abuse.cloudflare.com',
    'https://support.google.com/websearch/answer/106230',
  ])];
}
