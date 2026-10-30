import { nameForms, canonicalUrl, norm } from './text.js';
import { buildSeedQueries, mergeQueries, queriesFromSuggestions } from './queries.js';
import { prefilter, shouldEarlyStop } from './rank.js';
import { fetchContext } from './fetchText.js';
import { classifyHeuristic, classifyWithClaude } from './classify.js';
import { expandQueries } from './expand.js';
import { cloudAiEnabled } from './llm.js';
import { search, autocomplete, countryCodeOf, EXTERNAL } from './serp.js';
import { CATEGORY_SIGNALS } from './lexicon.js';
import { cacheGet, cacheKey, checkBudget, recordUsage, reserveSerp } from './budget.js';

export const sensitiveText = text => /\b(?:nudes?|naked|porn(?:ography)?|sex(?:ual)?\s+(?:tapes?|videos?|images?|abuse)|intimate\s+(?:images?|content|videos?)|revenge\s+porn|child\s+(?:sexual|abuse))\b|裸照|色情/i.test(String(text || ''));
export const scanData = row => {
  const context = JSON.parse(row.context_json);
  return { ...row, variants: JSON.parse(row.variants_json), context, subject_type: context.subject_type === 'business' ? 'business' : 'person', harm_types: JSON.parse(row.harm_types_json) };
};
const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
const num = (env, key, fallback, max = 100) => Math.max(1, Math.min(max, Number(env[key]) || fallback));
const usageOf = u => ({ inTok: u?.in || 0, outTok: u?.out || 0 });

// Imports, deletion and polling use the same lease, so an in-flight step cannot
// recreate data after deletion. Release only the lease acquired by this caller.
export async function acquireLease(db, id) {
  const now = Date.now(), lease = now + 30_000;
  const result = await db.prepare('UPDATE scans SET lease_until = ? WHERE id = ? AND lease_until < ?').bind(lease, id, now).run();
  return result.meta.changes ? lease : null;
}
export async function releaseLease(db, id, lease) {
  await db.prepare('UPDATE scans SET lease_until = 0 WHERE id = ? AND lease_until = ?').bind(id, lease).run();
}

export async function insertHits(env, scan, rows, source = '') {
  const db = env.DB;
  const existing = await all(db, 'SELECT canonical_url, domain FROM hits WHERE scan_id = ?', scan.id);
  const seen = new Set(existing.map(h => h.canonical_url));
  const domainCounts = new Map();
  for (const h of existing) domainCounts.set(h.domain, (domainCounts.get(h.domain) || 0) + 1);
  // Keep only ordinary public web URLs. Fetching has additional text/media guards.
  const valid = (rows || []).filter(r => {
    try { const u = new URL(r.url); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; }
  });
  const forms = nameForms(scan.full_name, scan.variants, scan.context.usernames, scan.subject_type);
  const { kept } = prefilter(valid, forms, { seen, domainCounts, domainCap: num(env, 'DOMAIN_CAP', 3, 10) });
  if (kept.length) await db.batch(kept.map(h => {
    const sensitive = sensitiveText(`${h.title || ''} ${h.snippet || ''} ${h.url}`);
    return db.prepare(`INSERT OR IGNORE INTO hits
      (scan_id, kind, url, canonical_url, domain, title, snippet, source_query, created_at, classified, category, severity, match_confidence, reason, fetch_state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(scan.id, h.kind || 'web', h.url, h.canonical_url, h.domain,
        sensitive ? 'Sensitive result — support available' : String(h.title || '').slice(0, 300),
        sensitive ? '' : String(h.snippet || '').slice(0, 1000), source, Date.now(),
        sensitive ? 1 : 0, sensitive ? 'sensitive_intimate' : null, sensitive ? 5 : null,
        sensitive ? 0 : null, sensitive ? 'Use the support resources; this result was not opened.' : null,
        sensitive || h.kind === 'autocomplete' ? 'skipped' : 'pending');
  }));
  return kept.length;
}

async function addQueries(env, scan, incoming) {
  const existing = await all(env.DB, 'SELECT q, priority, source FROM queries WHERE scan_id = ?', scan.id);
  const existingKeys = new Set(existing.map(x => norm(x.q)));
  const room = Math.max(0, num(env, 'MAX_QUERIES', 60, 100) - existing.length);
  const fresh = mergeQueries([incoming], 100).filter(x => !existingKeys.has(norm(x.q)) && !sensitiveText(x.q)).slice(0, room);
  if (fresh.length) await env.DB.batch(fresh.map(q => env.DB.prepare('INSERT OR IGNORE INTO queries (scan_id, q, priority, source) VALUES (?, ?, ?, ?)').bind(scan.id, q.q, q.priority, q.source)));
}

export async function stepScan(env, id, { fetchImpl = fetch } = {}) {
  const db = env.DB;
  let row = await db.prepare('SELECT * FROM scans WHERE id = ?').bind(id).first();
  if (!row || ['done', 'error', 'help_only'].includes(row.status)) return;
  const lease = await acquireLease(db, id);
  if (!lease) return;
  const deadline = Date.now() + 13_000;
  const remaining = () => Math.max(1, deadline - Date.now());
  const boundedFetch = (url, options = {}) => fetchImpl(url, { ...options, signal: AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(Math.min(6000, remaining()))]) });
  try {
    row = await db.prepare('SELECT * FROM scans WHERE id = ?').bind(id).first();
    const scan = scanData(row);
    const hasCountryChoice = Object.hasOwn(scan.context, 'country_code');
    const providerEnv = { ...env, SERP_PROVIDER: scan.provider, SCAN_SUBJECT_TYPE: scan.subject_type,
      ...(hasCountryChoice ? { SERP_GL: scan.context.country_code } : {}) };
    const forms = nameForms(scan.full_name, scan.variants, scan.context.usernames, scan.subject_type);
    if (scan.status === 'paused_budget') {
      if (!(await checkBudget(env, db)).ok) return;
      // Planning may have paused before its first query was inserted.
      const q = await db.prepare('SELECT COUNT(*) AS n FROM queries WHERE scan_id = ?').bind(id).first();
      scan.status = q.n ? (scan.provider === 'session' ? 'awaiting_import' : 'searching') : 'planning';
      await db.prepare('UPDATE scans SET status = ? WHERE id = ?').bind(scan.status, id).run();
    }
    if (scan.status === 'planning') {
      if ((cloudAiEnabled(env) || EXTERNAL.has(scan.provider)) && !(await checkBudget(env, db)).ok) {
        await db.prepare("UPDATE scans SET status = 'paused_budget' WHERE id = ?").bind(id).run(); return;
      }
      if (EXTERNAL.has(scan.provider) && !env.SERP_API_KEY) throw new Error('missing_serp_key');
      const planning = await Promise.allSettled([
        cloudAiEnabled(env) && scan.provider !== 'mock'
          ? expandQueries(env, scan, forms, boundedFetch)
          : { queries: [], usage: null },
        Promise.all([`${scan.full_name} `, `${scan.full_name} s`].map(async p => {
          if (['serper', 'serpapi'].includes(scan.provider) && !(await reserveSerp(env, db, id))) return [];
          return autocomplete(providerEnv, p, boundedFetch);
        })).then(x => x.flat()),
      ]);
      // Drain all work before releasing the lease, including failed requests.
      if (planning.some(x => x.status === 'rejected')) throw planning.find(x => x.status === 'rejected').reason;
      const [expansion, suggestions] = planning.map(x => x.value);
      if (expansion.usage) await recordUsage(env, db, id, usageOf(expansion.usage));
      await addQueries(env, scan, mergeQueries([buildSeedQueries(scan), expansion.queries], num(env, 'MAX_QUERIES', 60, 100)));
      const signals = Object.values(CATEGORY_SIGNALS).flat();
      const autos = queriesFromSuggestions(suggestions, forms).filter(x => !sensitiveText(x.q) && signals.some(t => norm(x.q).includes(t)))
        .map(x => ({ title: x.q, snippet: 'Search suggestion, not evidence of an allegation or event.', url: `https://www.google.com/search?q=${encodeURIComponent(x.q)}`, kind: 'autocomplete' }));
      await insertHits(env, scan, autos, 'autocomplete');
      await db.prepare('UPDATE scans SET status = ?, error = NULL WHERE id = ?').bind(scan.provider === 'session' ? 'awaiting_import' : 'searching', id).run();
      return;
    }
    if (scan.provider !== 'session') {
      if (EXTERNAL.has(scan.provider) && !(await checkBudget(env, db)).ok) {
        await db.prepare("UPDATE scans SET status = 'paused_budget' WHERE id = ?").bind(id).run(); return;
      }
      const pending = await all(db, "SELECT * FROM queries WHERE scan_id = ? AND status = 'pending' ORDER BY priority, id LIMIT ?", id, num(env, 'SEARCH_BATCH', 8, 10));
      // Cache identity includes the actual request geography, including no
      // preference. Legacy scans used deployment configuration, not country
      // labels; keep them separate from explicitly selected countries and old
      // unscoped cache entries. Mock fixture text also depends on subject type.
      const providerIdentity = scan.provider === 'mock' && scan.subject_type === 'business' ? 'mock:business' : scan.provider;
      const cacheProvider = `country-v1:${providerIdentity}:${hasCountryChoice ? 'selected' : 'legacy'}:${countryCodeOf(providerEnv) || 'none'}`;
      // Fetch concurrently; persist results serially to preserve dedupe/domain caps.
      const responses = await Promise.allSettled(pending.map(async q => {
        let data = await cacheGet(env, db, cacheProvider, q.q);
        if (!data) {
          // Reserve usage before a paid call: failed requests can still cost money.
          if (EXTERNAL.has(scan.provider)) {
            if (!(await reserveSerp(env, db, id))) return { q, paused: true };
          }
          data = await search(providerEnv, q.q, boundedFetch);
          await db.batch([
            db.prepare('INSERT OR REPLACE INTO serp_cache (key, json, created_at) VALUES (?, ?, ?)').bind(cacheKey(cacheProvider, q.q), JSON.stringify(data), Date.now()),
            db.prepare('INSERT OR IGNORE INTO scan_cache (scan_id, cache_key) VALUES (?, ?)').bind(id, cacheKey(cacheProvider, q.q)),
          ]);
        }
        await db.prepare('INSERT OR IGNORE INTO scan_cache (scan_id, cache_key) VALUES (?, ?)').bind(id, cacheKey(cacheProvider, q.q)).run();
        return { q, data };
      }));
      for (const response of responses) {
        if (response.status === 'rejected') continue;
        const { q, data, paused } = response.value;
        if (paused) { await db.prepare("UPDATE scans SET status = 'paused_budget' WHERE id = ?").bind(id).run(); continue; }
        const count = await insertHits(env, scan, data.results, q.q);
        await db.prepare("UPDATE queries SET status = 'done', results = ? WHERE id = ?").bind(count, q.id).run();
        await addQueries(env, scan, queriesFromSuggestions(data.related, forms, 10));
      }
      if (responses.some(x => x.status === 'rejected')) throw responses.find(x => x.status === 'rejected').reason;
    }
    if (remaining() > 1500) {
      const hits = await all(db, 'SELECT * FROM hits WHERE scan_id = ? AND classified = 0 ORDER BY id LIMIT ?', id, num(env, 'CLASSIFY_BATCH', 10, 15));
      const enrichment = await Promise.allSettled(hits.map(async h => {
        const result = scan.provider === 'mock' || h.kind === 'autocomplete'
          ? { state: 'skipped', text: '' }
          : await fetchContext(h.url, forms, { fetchImpl: boundedFetch, timeoutMs: Math.min(3000, remaining()) });
        await db.prepare('UPDATE hits SET context_text = ?, fetch_state = ? WHERE id = ?').bind(result.text || '', result.state, h.id).run();
        return { ...h, context_text: result.text || '' };
      }));
      if (enrichment.some(x => x.status === 'rejected')) throw enrichment.find(x => x.status === 'rejected').reason;
      const enriched = enrichment.map(x => x.value);
      const general = enriched.filter(h => !sensitiveText(h.context_text));
      let classifications = new Map();
      if (general.length && cloudAiEnabled(env) && scan.provider !== 'mock' && remaining() > 1000) {
        if (!(await checkBudget(env, db)).ok) {
          await db.prepare("UPDATE scans SET status = 'paused_budget' WHERE id = ?").bind(id).run(); return;
        }
        const result = await classifyWithClaude(env, scan, general, boundedFetch);
        classifications = result.results;
        await recordUsage(env, db, id, usageOf(result.usage));
      }
      for (const h of enriched) {
        const cls = sensitiveText(h.context_text)
          ? { category: 'sensitive_intimate', severity: 5, match_confidence: 0, reason: 'Support resources are available for this result.' }
          : classifications.get(h.id) || classifyHeuristic(scan, h);
        await db.prepare('UPDATE hits SET classified = 1, category = ?, severity = ?, match_confidence = ?, reason = ? WHERE id = ?')
          .bind(cls.category, Number.isFinite(cls.severity) ? cls.severity : 0, cls.match_confidence, cls.reason, h.id).run();
        if (cls.category === 'sensitive_intimate') await db.prepare("UPDATE hits SET title = 'Sensitive result — support available', snippet = '', context_text = '' WHERE id = ?").bind(h.id).run();
      }
    }
    const hits = await all(db, 'SELECT * FROM hits WHERE scan_id = ?', id);
    if (shouldEarlyStop(hits, num(env, 'SHOW_LIMIT', 10, 10))) await db.prepare("UPDATE queries SET status = 'skipped' WHERE scan_id = ? AND status = 'pending' AND priority = 4").bind(id).run();
    const pending = await db.prepare("SELECT COUNT(*) AS n FROM queries WHERE scan_id = ? AND status = 'pending'").bind(id).first();
    if (!pending.n && !hits.some(h => !h.classified)) await db.prepare("UPDATE scans SET status = 'done', error = NULL WHERE id = ?").bind(id).run();
  } catch (error) {
    // Never persist provider response bodies (they may contain credentials/data).
    const message = /^(?:serper|serpapi|brave)_(?:401|403)$/.test(error?.message || '')
      ? 'The search provider rejected the configured API credentials. Check that the key belongs to the selected search provider, then retry.'
      : error?.name === 'AbortError' || error?.name === 'TimeoutError'
        ? 'A service timed out. Retry to continue from the last completed step.'
        : 'This scan could not finish its current step. Check the provider settings, then retry.';
    await db.prepare("UPDATE scans SET status = 'error', error = ? WHERE id = ?").bind(message, id).run();
  } finally { await releaseLease(db, id, lease); }
}
