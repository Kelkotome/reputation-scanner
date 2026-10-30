// Query-only transport to an operator-configured SearXNG instance. No AI,
// provider fallback, source-page requests, payload logging or content storage.
import { SEARCH_RESULT_LIMIT, safeSearchEngines } from './search-limits.js';

export const SEARXNG_MAX_BYTES = 512 * 1024;
const error = code => new Error(`searxng_${code}`);

function configuration(env) {
  let url;
  try { url = new URL(env.SEARXNG_URL); } catch { throw error('configuration'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && env.SEARXNG_ALLOW_LOOPBACK_HTTP === 'true'))) throw error('configuration');
  // A base URL may include a deployment prefix; an explicit /search is also OK.
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/search') ? path : `${path}/search`;
  const rawToken = env.SEARXNG_TOKEN === undefined ? '' : env.SEARXNG_TOKEN;
  if (typeof rawToken !== 'string' || /[\u0000-\u001f\u007f]/.test(rawToken)) throw error('configuration');
  const token = rawToken.trim();
  if ((token && !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) || rawToken.length > 1024) throw error('configuration');
  const proxyKey = env.SEARXNG_PROXY_KEY === undefined ? '' : env.SEARXNG_PROXY_KEY;
  if (typeof proxyKey !== 'string' || proxyKey.length > 1024
    || (proxyKey && !/^[A-Za-z0-9._~+/-]+=*$/.test(proxyKey))
    || (proxyKey && url.protocol !== 'https:')) throw error('configuration');
  const accessId = env.SEARXNG_ACCESS_CLIENT_ID === undefined ? '' : env.SEARXNG_ACCESS_CLIENT_ID;
  const accessSecret = env.SEARXNG_ACCESS_CLIENT_SECRET === undefined ? '' : env.SEARXNG_ACCESS_CLIENT_SECRET;
  // Access credentials are opaque server-only tokens: validate header safety and
  // bounds without depending on one generation of Cloudflare's token format.
  if (typeof accessId !== 'string' || accessId.length > 256 || /[\u0000-\u0020\u007f]/.test(accessId) || (accessId && !/^[A-Za-z0-9._-]+$/.test(accessId))
    || typeof accessSecret !== 'string' || accessSecret.length > 1024 || /[\u0000-\u0020\u007f]/.test(accessSecret) || (accessSecret && !/^[A-Za-z0-9._~+/-]+=*$/.test(accessSecret))
    || Boolean(accessId) !== Boolean(accessSecret)
    || (accessId && url.protocol !== 'https:')
    || (!loopback && !token && !accessId && !proxyKey)) throw error('configuration');
  if (typeof env.SEARXNG_ENGINES !== 'string') throw error('configuration');
  const engines = [...new Set(env.SEARXNG_ENGINES.split(',').map(value => value.trim().toLowerCase()))];
  if (!engines.length || engines.length > 3 || safeSearchEngines(engines).length !== engines.length) throw error('configuration');
  return { url, token, proxyKey, accessId, accessSecret, engines };
}

export function validateSearxngConfiguration(env) { configuration(env); }

export function configuredSearxngEngines(env) {
  try { return [...configuration(env).engines]; }
  catch { return []; }
}

async function readJson(response) {
  if (!/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '')) {
    await response.body?.cancel();
    throw error('response_format');
  }
  const length = response.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > SEARXNG_MAX_BYTES)) {
    await response.body?.cancel();
    throw error('response_too_large');
  }
  if (!response.body) throw error('response_format');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SEARXNG_MAX_BYTES) { await reader.cancel(); throw error('response_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw error('response_format'); }
}

function publicResultUrl(raw) {
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
const text = (value, max) => typeof value === 'string'
  ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';

export async function searchSearxng(env, query, fetchImpl = fetch, { page = 1, timeoutMs = 12000 } = {}) {
  const { url, token, proxyKey, accessId, accessSecret, engines } = configuration(env);
  // SearXNG bang syntax can override engine/category parameters or redirect to
  // another service. This adapter supports ordinary web queries only.
  if (typeof query !== 'string' || !query.trim() || query.length > 500
    || /[!\u0000-\u001f\u007f]/.test(query)) throw error('query');
  if (!Number.isInteger(page) || page < 1 || page > 3) throw error('page');
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 12000) throw error('timeout_configuration');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      // Workers support manual/follow, not redirect:error. The non-OK guard
      // below rejects redirects without following or exposing their Location.
      method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(proxyKey ? { 'X-Proxy-Key': proxyKey } : {}),
        ...(accessId ? { 'CF-Access-Client-Id': accessId, 'CF-Access-Client-Secret': accessSecret } : {}) },
      // Do not add categories=general: SearXNG unions its category engines with
      // the explicit engine list. The instance must also enforce engines.keep_only.
      // Google get_google_info clears its document-language restriction (lr)
      // for "all": https://github.com/searxng/searxng/blob/master/searx/engines/google.py
      body: new URLSearchParams({ q: query, format: 'json', language: 'all', safesearch: '0', engines: engines.join(','), ...(page > 1 ? { pageno: String(page) } : {}) }).toString(),
      signal: controller.signal,
    });
    if (!response.ok) { await response.body?.cancel(); throw error(`http_${response.status}`); }
    const data = await readJson(response);
    if (!data || typeof data !== 'object' || !Array.isArray(data.results)
      || (data.unresponsive_engines !== undefined && !Array.isArray(data.unresponsive_engines))) throw error('response_format');
    if (data.error || (Array.isArray(data.errors) ? data.errors.length : data.errors)) throw error('response_error');
    const results = [], reportedEngines = new Set();
    let invalid = 0, limited = 0;
    for (const item of data.results) {
      const resultUrl = publicResultUrl(item?.url);
      if (!resultUrl) { invalid++; continue; }
      for (const engine of safeSearchEngines([item?.engine])) reportedEngines.add(engine);
      for (const engine of safeSearchEngines(item?.engines)) reportedEngines.add(engine);
      if (results.length >= SEARCH_RESULT_LIMIT) { limited++; continue; }
      results.push({ title: text(item.title, 500), url: resultUrl, snippet: text(item.content, 2000) });
    }
    const partial = Boolean(data.unresponsive_engines?.length);
    if (!results.length && partial) throw error('engines_unavailable');
    return { results, related: [], coverage: { returned: data.results.length, invalid, limited,
      engines: [...reportedEngines] }, ...(partial ? { partial: true } : {}) };
  } catch (failure) {
    // Never expose fetch errors, instance URLs, headers or provider response text.
    if (/^searxng_(http_\d{3}|response_format|response_too_large|response_error|engines_unavailable)$/.test(failure?.message || '')) throw failure;
    throw error(controller.signal.aborted ? 'timeout' : 'request_failed');
  } finally { clearTimeout(timer); }
}
