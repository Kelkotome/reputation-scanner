// Text-only page fetch with hard guards:
//  - never fetches file hosts, messaging channels or media URLs (snippet-only scoring for those)
//  - only accepts text/html, stops reading after MAX_BYTES, times out
//  - refuses private / local addresses (SSRF guard)
// Returns short text windows around name mentions, never the whole page.

import { hostOf, norm } from './text.js';

// Hosts we never fetch: file lockers, messaging channels, and adult-content hosts.
const NEVER_FETCH = new Set([
  'mega.nz', 'mega.io', 'drive.google.com', 'docs.google.com', 'dropbox.com', 'mediafire.com',
  't.me', 'telegram.me', 'telegram.org', 'discord.gg', 'discord.com', 'wa.me', 'tumblr.com',
  'onlyfans.com', 'fansly.com',
]);
const ADULT_HOST_HINT = /(porn|xxx|xvideo|xnxx|xhamster|hentai|nsfw|onlyfans|fansly|camgirl|leak)/i;
const MEDIA_EXT = /\.(jpe?g|png|gif|webp|avif|bmp|heic|svg|mp4|mov|webm|mkv|avi|m4v|mp3|wav|zip|rar|7z|pdf|exe|apk|dmg)(\?|$)/i;
function privateIpv4(host) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function privateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (!host.startsWith('[')) return privateIpv4(host);
  const address = host.slice(1, -1);
  // URL canonicalises IPv6, including dotted IPv4-mapped addresses.
  if (address === '::' || address === '::1' || /^(fc|fd|fe[89ab]|ff)/i.test(address)) return true;
  const mapped = address.match(/^::(?:ffff:)?([\da-f]+):([\da-f]+)$/i);
  if (!mapped) return false;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return privateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
}

export const MAX_BYTES = 200_000;

/** @returns {{ok:true}|{ok:false, reason:string}} */
export function fetchAllowed(url) {
  let u;
  try { u = new URL(url); } catch { return { ok: false, reason: 'bad_url' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: 'protocol' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (privateHost(host)) return { ok: false, reason: 'private_host' };
  if ([...NEVER_FETCH].some(blocked => host === blocked || host.endsWith('.' + blocked))) {
    return { ok: false, reason: 'never_fetch_host' };
  }
  if (ADULT_HOST_HINT.test(host)) return { ok: false, reason: 'never_fetch_host' };
  if (MEDIA_EXT.test(u.pathname)) return { ok: false, reason: 'media_url' };
  return { ok: true };
}

export function isTextHtml(contentType) {
  return /^(text\/html|application\/xhtml\+xml)/i.test(String(contentType || ''));
}

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Up to `max` windows of ±radius chars around name mentions. */
export function nameWindows(text, forms, radius = 280, max = 3) {
  const low = norm(text);
  const src = low; // windows come from normalised text so indexes line up
  const wins = [];
  for (const f of forms) {
    let i = src.indexOf(f);
    while (i !== -1 && wins.length < max) {
      const a = Math.max(0, i - radius), b = Math.min(src.length, i + f.length + radius);
      if (!wins.some(([x, y]) => a < y && b > x)) wins.push([a, b]);
      i = src.indexOf(f, i + f.length);
    }
    if (wins.length >= max) break;
  }
  return wins.map(([a, b]) => src.slice(a, b)).join(' … ');
}

async function readCapped(res, maxBytes) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = '', total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value.subarray(0, maxBytes - total);
    total += chunk.byteLength;
    out += dec.decode(chunk, { stream: true });
  }
  try { await reader.cancel(); } catch {}
  return out + dec.decode();
}

/**
 * @returns {Promise<{state:'fetched'|'blocked'|'failed', text?:string, reason?:string}>}
 */
export async function fetchContext(url, forms, { timeoutMs = 5000, fetchImpl = fetch, maxRedirects = 3 } = {}) {
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const allowed = fetchAllowed(current);
    if (!allowed.ok) return { state: 'blocked', reason: allowed.reason };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(current, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; NameScanner/0.1; self-search reputation check)',
          'Accept': 'text/html,application/xhtml+xml;q=0.9',
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location'), current).toString();
        continue; // re-check guards on the redirect target
      }
      if (!res.ok) return { state: 'failed', reason: `http_${res.status}` };
      if (!isTextHtml(res.headers.get('content-type'))) {
        try { await res.body?.cancel(); } catch {}
        return { state: 'blocked', reason: 'not_html' };
      }
      const html = await readCapped(res, MAX_BYTES);
      const text = htmlToText(html);
      return { state: 'fetched', text: nameWindows(text, forms).slice(0, 1800) };
    } catch (e) {
      return { state: 'failed', reason: e.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { state: 'failed', reason: 'too_many_redirects' };
}

export { hostOf };
