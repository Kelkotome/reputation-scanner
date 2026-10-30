import { configuredSearxngEngines, searchSearxng } from './searxng.js';
import { safeSearchEngines } from './search-limits.js';
import { search } from './serp.js';

const NEUTRAL_QUERIES = ['example.com', 'wikipedia', 'OpenStreetMap'];

// A combined response can hide a selected engine's failure behind another
// engine's results. Probe each configured engine separately; retain only counts
// and public labels, never result text, provider errors or connection secrets.
export async function preflightSearxng(env, searchImpl = searchSearxng) {
  const engines = configuredSearxngEngines(env);
  if (!engines.length) throw new Error('searxng_configuration');
  const checks = await Promise.all(engines.map(async engine => {
    let attempts = 0;
    const selected = { ...env, SEARXNG_ENGINES: engine };
    for (const query of NEUTRAL_QUERIES) {
      attempts++;
      let response;
      try { response = await searchImpl(selected, query); }
      catch { return { engine, verified: false, attempts, results: 0, reason: 'unavailable' }; }
      if (response?.partial === true) return { engine, verified: false, attempts, results: 0, reason: 'incomplete' };
      const count = Array.isArray(response?.results) ? response.results.length : 0;
      if (count && safeSearchEngines(response?.coverage?.engines).includes(engine)) {
        return { engine, verified: true, attempts, results: count };
      }
    }
    return { engine, verified: false, attempts, results: 0, reason: 'no_attributed_results' };
  }));
  return { passed: checks.every(check => check.verified), checks };
}

// Probe the primary directly: a backup response must never make an unavailable
// SearXNG engine appear verified. Only the explicit backup probe uses SerpApi.
async function probeLiveProvider(env, query) {
  return env.SERP_PROVIDER === 'serpapi' ? search(env, query) : searchSearxng(env, query);
}

export async function preflightLiveSearch(env, searchImpl = probeLiveProvider) {
  const primary = await preflightSearxng({ ...env, SERP_PROVIDER: 'searxng' }, searchImpl);
  const provider = String(env.GOOGLE_BACKUP_PROVIDER || 'none').trim().toLowerCase();
  let backup = { provider: null, enabled: false, verified: false, attempts: 0, results: 0, reason: 'disabled' };
  if (provider !== 'none') {
    backup = { provider: provider === 'serpapi' ? 'serpapi' : null, enabled: true,
      verified: false, attempts: 0, results: 0, reason: 'configuration' };
    const key = env.SERPAPI_API_KEY;
    if (provider === 'serpapi' && typeof key === 'string' && key.length > 0 && key.length <= 1024
      && !/[^\u0021-\u007e]/.test(key)) {
      backup.attempts = 1;
      try {
        // Match the SearXNG workflow: country remains local identity context.
        const response = await searchImpl({ ...env, SERP_PROVIDER: 'serpapi', SERP_API_KEY: key, SERP_GL: '' }, 'wikipedia');
        const count = Array.isArray(response?.results) ? response.results.length : 0;
        if (response?.partial === true) backup.reason = 'incomplete';
        else if (count && safeSearchEngines(response?.coverage?.engines).includes('google')) {
          backup = { provider: 'serpapi', enabled: true, verified: true, attempts: 1, results: count };
        } else backup.reason = 'no_attributed_results';
      } catch { backup.reason = 'unavailable'; }
    }
  }
  const degraded = !primary.passed;
  const passed = primary.passed || (primary.checks.some(check => check.verified) && backup.verified);
  return { passed, degraded, primary, backup };
}
