import { allLinks } from '../src/platforms.js';

// No blanket exceptions: authentication/bot restrictions must be reviewed against
// the official service and recorded explicitly here with a source and date.
export const VERIFIED_RESTRICTIONS = {
  'https://help.x.com/en/forms': {
    statuses: [403], header: ['cf-mitigated', 'challenge'], checked: '2026-09-24', expires: '2026-12-24',
    source: 'https://help.x.com/en/forms', reason: 'Verified Cloudflare browser challenge; official X reporting topics remain accessible in web search.',
  },
  'https://help.glassdoor.com': {
    statuses: [403], header: ['cf-mitigated', 'challenge'], checked: '2026-09-24', expires: '2026-12-24',
    source: 'https://www.glassdoor.com/blog/responding-to-negative-glassdoor-reviews-faqs/', reason: 'Verified Cloudflare browser challenge; official Glassdoor reporting guidance links to this Help Center.',
  },
  'https://abuse.cloudflare.com': {
    statuses: [403], header: ['server', 'cloudflare'], checked: '2026-09-24', expires: '2026-12-24',
    source: 'https://developers.cloudflare.com/fundamentals/reference/report-abuse/submit-report/', reason: 'Verified Cloudflare security block page (Attention Required); current official documentation confirms this public form.',
  },
};

export async function checkLink(url, fetchImpl = fetch, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'follow', signal: controller.signal,
      headers: { 'User-Agent': 'NameScanner-LinkCheck/0.1', Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' },
    });
    // Link verification never downloads page bodies, images or attachments.
    await response.body?.cancel();
    const restriction = VERIFIED_RESTRICTIONS[url];
    const verified = restriction && restriction.expires >= new Date().toISOString().slice(0, 10)
      && restriction.statuses.includes(response.status) && response.headers.get(restriction.header[0]) === restriction.header[1];
    return { url, status: response.status, ok: response.status === 200 || Boolean(verified),
      restricted: Boolean(verified),
      reason: response.status === 200 ? 'OK' : verified ? restriction.reason : `HTTP ${response.status} ${response.statusText}`.trim(), finalUrl: response.url || url };
  } catch (error) {
    return { url, status: null, ok: false, reason: error.name === 'AbortError' ? 'timeout' : error.cause?.code || error.message };
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const urls = allLinks(), results = [];
  for (let index = 0; index < urls.length; index += 5) {
    const batch = await Promise.all(urls.slice(index, index + 5).map((url) => checkLink(url)));
    for (const result of batch) {
      results.push(result);
      console.log(`${result.restricted ? 'REVIEWED' : result.ok ? 'PASS' : 'FAIL'} ${result.status ?? 'ERR'} ${result.url} — ${result.reason}`);
    }
  }
  const failed = results.filter((r) => !r.ok);
  const restricted = results.filter((r) => r.restricted).length;
  console.log(`\n${results.length - failed.length - restricted} HTTP 200; ${restricted} verified access restrictions; ${failed.length} require review.`);
  if (failed.length) process.exitCode = 1;
}
