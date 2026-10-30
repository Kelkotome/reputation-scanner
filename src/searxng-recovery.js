import { configuredSearxngEngines, searchSearxng } from './searxng.js';
import { SEARCH_RESULT_LIMIT, safeSearchEngines } from './search-limits.js';

const MAX_RETRY_MS = 12000;
const MIN_RETRY_MS = 1000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeCount = value => Number.isSafeInteger(value) && value >= 0;

function usableResult(result) {
  if (!object(result) || typeof result.title !== 'string' || result.title.length > 500
    || typeof result.snippet !== 'string' || result.snippet.length > 2000
    || typeof result.url !== 'string' || result.url.length > 2048
    || /[\u0000-\u0020\u007f]/.test(result.url)) return false;
  let url;
  try { url = new URL(result.url); } catch { return false; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !host.includes('.')
    || host.startsWith('[') || /(^|\.)(localhost|local|internal)$/.test(host)) return false;
  if (/^\d+(\.\d+){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  return true;
}

const validResults = record => object(record) && Array.isArray(record.results)
  && record.results.length <= SEARCH_RESULT_LIMIT && record.results.every(usableResult)
  && object(record.coverage) && Array.isArray(record.coverage.engines)
  && ['returned', 'invalid', 'limited'].every(key => safeCount(record.coverage[key]))
  && record.coverage.returned === record.results.length + record.coverage.invalid + record.coverage.limited;
const explicitFailure = record => record?.partial === true || Boolean(record?.error)
  || Boolean(Array.isArray(record?.errors) ? record.errors.length : record?.errors)
  || Boolean(Array.isArray(record?.unresponsive_engines) ? record.unresponsive_engines.length : record?.unresponsive_engines)
  || record?.captcha === true || record?.rate_limited === true
  || record?.status === 403 || record?.status === 429;
const text = value => value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();

function safeRecord(record) {
  const results = record.results.map(({ title, url, snippet }) => ({ title: text(title), url, snippet: text(snippet) }));
  return { results, related: [], coverage: {
    returned: record.coverage.returned, invalid: record.coverage.invalid, limited: record.coverage.limited,
    engines: safeSearchEngines(record.coverage?.engines),
  }, ...(record.partial === true ? { partial: true } : {}) };
}

function tagged(first, status, attempts, retry) {
  const result = safeRecord(first);
  if (retry) {
    const next = safeRecord(retry), combined = [...result.results, ...next.results];
    result.results = combined.slice(0, SEARCH_RESULT_LIMIT);
    result.coverage.returned += next.coverage.returned;
    result.coverage.invalid += next.coverage.invalid;
    result.coverage.limited += next.coverage.limited + combined.length - result.results.length;
    result.coverage.engines = safeSearchEngines([...result.coverage.engines, ...next.coverage.engines]);
  }
  result.coverage.google_recovery = status;
  result.coverage.attempts = attempts;
  return result;
}

// One same-query, same-page retry can recover silent empty Google responses.
// Explicit failures never trigger another request to the same service. A
// consented independent SerpApi backup can supply Google while preserving the
// primary response's incomplete status. The caller reserves the extra request.
export async function recoverMissingGoogle(env, query, first, {
  page = 1, searchImpl = searchSearxng, fetchImpl = fetch,
  reserve = async () => null, finish = async () => {}, remainingMs = () => MAX_RETRY_MS,
  backupProvider = null,
} = {}) {
  const independentBackup = backupProvider === 'serpapi';
  if (!configuredSearxngEngines(env).includes('google') || !validResults(first) || (explicitFailure(first) && !independentBackup)
    || first.coverage.attempts >= 2 || safeSearchEngines(first.coverage.engines).includes('google')) return first;

  const tag = (status, attempts, retry) => {
    const output = tagged(first, status, attempts, retry);
    if (independentBackup) output.coverage.google_backup_provider = 'serpapi';
    return output;
  };

  const timeLeft = () => {
    try {
      const value = typeof remainingMs === 'function' ? remainingMs() : remainingMs;
      return typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_RETRY_MS, Math.floor(value)) : 0;
    } catch { return 0; }
  };
  if (timeLeft() < MIN_RETRY_MS) return tag('time_skipped', 1);
  let reservation;
  try { reservation = await reserve(); }
  catch { return tag('budget_skipped', 1); }
  if (reservation === null || reservation === undefined || reservation === false) return tag('budget_skipped', 1);

  let success = false;
  try {
    const timeoutMs = timeLeft();
    if (timeoutMs < MIN_RETRY_MS) return tag('time_skipped', 1);
    let retry;
    try { retry = await searchImpl({ ...env, SEARXNG_ENGINES: 'google' }, query, fetchImpl, { page, timeoutMs }); }
    catch { return tag('failed', 2); }
    if (!validResults(retry) || explicitFailure(retry)
      || !Number.isSafeInteger(first.coverage.returned + retry.coverage.returned)
      || (retry.results.length > 0 && !safeSearchEngines(retry.coverage.engines).includes('google'))) return tag('failed', 2);
    success = retry.results.length > 0 && safeSearchEngines(retry.coverage.engines).includes('google');
    return tag(success ? 'recovered' : 'empty', 2, retry);
  } finally {
    // Settlement failures must not discard the first response or leak details.
    try { await finish(reservation, success); } catch {}
  }
}
