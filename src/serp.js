// Search provider adapter. Every provider returns {results:[{title,url,snippet}], related:[string]}.
//   session : no API. Queries are exported, run by an operator (e.g. a Claude Code session), and imported.
//   mock    : deterministic fixtures for UI/pipeline testing.
//   serper | serpapi | brave : paid APIs (set SERP_API_KEY).
//   searxng: fixed private instance; no autocomplete or country routing.
import { searchSearxng } from './searxng.js';
import { SEARCH_RESULT_LIMIT } from './search-limits.js';

export const EXTERNAL = new Set(['serper', 'serpapi', 'brave', 'searxng']);
export const GOOGLE_API_MAX_BYTES = 512 * 1024;
const GOOGLE_API_TIMEOUT_MS = 12000;
const googleError = (provider, code) => new Error(`${provider}_${code}`);

async function googleJson(provider, response) {
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '')) {
    await response.body?.cancel();
    throw googleError(provider, 'response_format');
  }
  const length = response.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > GOOGLE_API_MAX_BYTES)) {
    await response.body?.cancel();
    throw googleError(provider, 'response_too_large');
  }
  if (!response.body) throw googleError(provider, 'response_format');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > GOOGLE_API_MAX_BYTES) { await reader.cancel(); throw googleError(provider, 'response_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw googleError(provider, 'response_format'); }
}

async function googleRequest(provider, url, options, fetchImpl, timeoutMs) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, redirect: 'manual', credentials: 'omit', cache: 'no-store',
      referrerPolicy: 'no-referrer', signal: controller.signal });
    if (!response.ok) { await response.body?.cancel(); throw googleError(provider, response.status); }
    return await googleJson(provider, response);
  } catch (failure) {
    if (new RegExp(`^${provider}_(\\d{3}|response_format|response_too_large)$`).test(failure?.message || '')) throw failure;
    throw googleError(provider, controller.signal.aborted ? 'timeout' : 'request_failed');
  } finally { clearTimeout(timer); }
}

function googleResultUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u0020\u007f]/.test(raw)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host.includes('.')
    || host.startsWith('[') || /(^|\.)(localhost|local|internal)$/.test(host)) return null;
  if (/^\d+(\.\d+){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      || (a === 100 && b >= 64 && b <= 127)) return null;
  }
  return url.href;
}
const googleText = (value, max) => typeof value === 'string'
  ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

function googleResults(provider, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw googleError(provider, 'response_format');
  if (data.error || (Array.isArray(data.errors) ? data.errors.length : data.errors)
    || ['Error', 'Processing', 'Queued'].includes(data.search_metadata?.status)
    || (Number.isInteger(data.statusCode) && data.statusCode >= 400)) throw googleError(provider, 'response_error');
  const organic = provider === 'serper' ? data.organic : data.organic_results;
  if (organic !== undefined && !Array.isArray(organic)) throw googleError(provider, 'response_format');
  const incoming = organic || [], results = [];
  let invalid = 0, limited = 0;
  for (const item of incoming) {
    const url = googleResultUrl(item?.link);
    if (!url) { invalid++; continue; }
    if (results.length >= SEARCH_RESULT_LIMIT) { limited++; continue; }
    results.push({ title: googleText(item.title, 500), url, snippet: googleText(item.snippet, 2000) });
  }
  const groups = provider === 'serper'
    ? [[data.relatedSearches, 'query'], [data.peopleAlsoAsk, 'question']]
    : [[data.related_searches, 'query'], [data.related_questions, 'question']];
  const related = groups.flatMap(([entries, key]) => Array.isArray(entries) ? entries.map(item => googleText(item?.[key], 500)) : [])
    .filter(Boolean).slice(0, 20);
  return { results, related, coverage: { returned: incoming.length, invalid, limited, engines: results.length ? ['google'] : [] } };
}

function validateGoogleSearch(provider, env, query, page, timeoutMs) {
  if (typeof env.SERP_API_KEY !== 'string' || !env.SERP_API_KEY || env.SERP_API_KEY.length > 1024
    || /[^\u0021-\u007e]/.test(env.SERP_API_KEY)) throw googleError(provider, 'configuration');
  if (typeof query !== 'string' || !query.trim() || query.length > 500
    || /[\u0000-\u001f\u007f]/.test(query)) throw googleError(provider, 'query');
  if (!Number.isInteger(page) || page < 1 || page > 3) throw googleError(provider, 'page');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > GOOGLE_API_TIMEOUT_MS) throw googleError(provider, 'timeout_configuration');
  // Do not silently return page one repeatedly while Serper pagination remains
  // unverified against its current official account documentation.
  if (provider === 'serper' && page > 1) throw googleError(provider, 'pagination_unavailable');
}

export function providerOf(env) {
  return String(env.SERP_PROVIDER || 'session').toLowerCase();
}

// Missing configuration preserves the legacy default. An explicit empty value
// means no country preference and must not silently select Singapore.
export function countryCodeOf(env) {
  return String(env.SERP_GL ?? 'sg').trim().toLowerCase();
}

export async function search(env, q, fetchImpl = fetch, { page = 1, timeoutMs = GOOGLE_API_TIMEOUT_MS } = {}) {
  const p = providerOf(env);
  if (p === 'mock') return mockSearch(q, env.SCAN_SUBJECT_TYPE);
  if (p === 'searxng') return searchSearxng(env, q, fetchImpl, { page, timeoutMs });
  if (!EXTERNAL.has(p)) throw new Error(`provider_${p}_has_no_live_search`);
  if (!env.SERP_API_KEY) throw new Error('no_serp_key');
  const gl = countryCodeOf(env);

  if (p === 'serper') {
    validateGoogleSearch(p, env, q, page, timeoutMs);
    const d = await googleRequest(p, 'https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': env.SERP_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ q, ...(gl ? { gl } : {}), hl: 'en', num: 10 }),
    }, fetchImpl, timeoutMs);
    return googleResults(p, d);
  }
  if (p === 'serpapi') {
    validateGoogleSearch(p, env, q, page, timeoutMs);
    const u = new URL('https://serpapi.com/search.json');
    // Official pagination/freshness parameters: https://serpapi.com/search-api
    u.search = new URLSearchParams({ engine: 'google', q, ...(gl ? { gl } : {}), hl: 'en', num: '10',
      start: String((page - 1) * 10), no_cache: 'true', api_key: env.SERP_API_KEY });
    const d = await googleRequest(p, u, { method: 'GET', headers: { Accept: 'application/json' } }, fetchImpl, timeoutMs);
    return googleResults(p, d);
  }
  // brave
  const u = new URL('https://api.search.brave.com/res/v1/web/search');
  u.search = new URLSearchParams({ q, ...(gl ? { country: gl === 'uk' ? 'GB' : gl.toUpperCase() } : {}), count: '10' });
  const res = await fetchImpl(u, { headers: { 'X-Subscription-Token': env.SERP_API_KEY, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`brave_${res.status}`);
  const d = await res.json();
  return {
    results: (d.web?.results || []).map((r) => ({ title: r.title, url: r.url, snippet: (r.description || '').replace(/<[^>]+>/g, '') })),
    related: (d.query?.related || []).filter(Boolean),
  };
}

/** Autocomplete suggestions. Returns [] for providers without it. */
export async function autocomplete(env, prefix, fetchImpl = fetch, { strict = false } = {}) {
  const p = providerOf(env);
  if (p === 'mock') return mockAutocomplete(prefix);
  if (p === 'searxng') return [];
  if (!env.SERP_API_KEY || !EXTERNAL.has(p)) return [];
  const gl = countryCodeOf(env);
  try {
    if (p === 'serper') {
      const res = await fetchImpl('https://google.serper.dev/autocomplete', {
        method: 'POST',
        headers: { 'X-API-KEY': env.SERP_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: prefix, ...(gl ? { gl } : {}) }),
      });
      if (!res.ok) throw new Error('autocomplete_failed');
      const d = await res.json();
      if (d.error || d.search_metadata?.status === 'Error') throw new Error('autocomplete_failed');
      return (d.suggestions || []).map((s) => s.value).filter(Boolean);
    }
    if (p === 'serpapi') {
      const u = new URL('https://serpapi.com/search.json');
      u.search = new URLSearchParams({ engine: 'google_autocomplete', q: prefix, ...(gl ? { gl } : {}), api_key: env.SERP_API_KEY });
      const res = await fetchImpl(u);
      if (!res.ok) throw new Error('autocomplete_failed');
      const d = await res.json();
      if (d.error || d.search_metadata?.status === 'Error') throw new Error('autocomplete_failed');
      return (d.suggestions || []).map((s) => s.value).filter(Boolean);
    }
  } catch {
    if (strict) throw new Error('autocomplete_failed');
    // Historical callers retain best-effort autocomplete.
  }
  return [];
}

// ---------------- mock fixtures ----------------
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

export function mockSearch(q, subjectType = 'person') {
  const business = subjectType === 'business';
  const name = (q.match(/"([^"]+)"/) || [null, q.split(' ').slice(0, 2).join(' ')])[1];
  const s = slug(name);
  const pool = [
    { title: `${name} | LinkedIn`, url: `https://sg.linkedin.com/${business ? 'company' : 'in'}/${s}`, snippet: business ? `${name}. A fictional business in Singapore. Public company profile.` : `${name}. Marketing director in Singapore. 500+ connections.` },
    { title: `Beware of ${name} - scam? : r/singapore`, url: `https://www.reddit.com/r/singapore/comments/abc123/beware_of_${s}`, snippet: `Anyone dealt with ${name}? Paid a deposit and money not returned, feels like a scam.` },
    { title: `${name} charged in court over cheating case - example news`, url: `https://news.example-sg.com/singapore/${s}-charged-court`, snippet: business ? `Fictional test fixture: ${name}, a different company in Malaysia, was named in a court claim. This is not a real allegation.` : `A man named ${name}, 52, from Malaysia was charged in court on Tuesday...` },
    { title: `${name} complaint thread | HardwareZone Forums`, url: `https://forums.hardwarezone.com.sg/threads/${s}-complaint.123/`, snippet: `Terrible service from ${name}, avoid. Called many times no reply.` },
    { title: business ? `${name} business address and phone number` : `${name} home address and phone number`, url: `https://people-directory.example.com/${s}`, snippet: business ? `${name} public business listing in Singapore: address and contact number for customer enquiries.` : `${name} lives at Blk 123 ... contact number 9xxx xxxx` },
    { title: `${name} wins industry award`, url: `https://www.example-mag.com/awards/${s}`, snippet: `${name} was recognised for excellence in digital marketing.` },
    // Reserved .example hosts: enough clearly synthetic mentions to exercise the
    // top-ten cap and full-list banner without ever fetching a real person's page.
    ...Array.from({ length: 14 }, (_, i) => ({
      title: `${name}: example complaint ${i + 1}`,
      url: `https://source${i + 1}.example/reviews/${s}`,
      snippet: `Fictional test fixture about ${name} in Singapore: a complaint says the service was terrible. This is not a real allegation.`,
    })),
  ];
  // Vary by query so different queries surface different subsets (exercises dedupe).
  const h = [...q].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const results = pool.filter((_, i) => ((h >> i) & 1) || i === h % pool.length);
  return { results, related: [`${name} scam reddit`, `${name} company`] };
}

export function mockAutocomplete(prefix) {
  const p = prefix.trim();
  return [`${p} scam`, `${p} linkedin`, `${p} age`];
}
