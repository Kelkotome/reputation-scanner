import { norm } from './text.js';
import { fetchAllowed } from './fetchText.js';
import { rankHits } from './rank.js';
import { providerOf, EXTERNAL } from './serp.js';
import { CATEGORY_LABELS } from './lexicon.js';
import { stepScan, scanData, insertHits, acquireLease, releaseLease } from './pipeline.js';
import { platformFor, googleChannelFor, HELP_LINKS } from './platforms.js';
import { lookupAbuse } from './abuse.js';
import { templatesFor, TEMPLATES } from './templates.js';
import { draftRequest } from './draft.js';
import { checkBudget } from './budget.js';
import { cloudAiEnabled } from './llm.js';
import { handleTakedowns } from './takedowns.js';
import { COUNTRIES, COUNTRY_ALIASES } from './countries.js';

const STATUSES = new Set(['not_me', 'resolved', 'sent', 'removed', 'refused', 'escalated']);
const HARMS = new Set([...Object.keys(CATEGORY_LABELS).filter(x => !['neutral', 'same_name_other_person'].includes(x)), 'child_safety']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COUNTRY_BY_CODE = new Map(COUNTRIES.map(country => [country.code, country.name]));
const COUNTRY_BY_NAME = new Map([
  ...COUNTRIES.map(country => [norm(country.name), country.code]),
  ...Object.entries(COUNTRY_ALIASES).map(([name, code]) => [norm(name), code]),
]);
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } });
const rows = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
function string(value, max, label, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new ApiError(400, `Invalid ${label}.`);
  return value.trim();
}
function list(value, max, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new ApiError(400, `Invalid ${label}.`);
  return value.map(v => string(v, 80, label, true));
}
function countryContext(context) {
  const invalid = () => new ApiError(400, 'Choose a country or region from the list, or leave it blank.');
  let code = '';
  if (Object.hasOwn(context, 'country_code')) {
    if (typeof context.country_code !== 'string') throw invalid();
    code = context.country_code.trim().toLowerCase();
    if (code === 'gb') code = 'uk';
    if (code && !COUNTRY_BY_CODE.has(code)) throw invalid();
  } else {
    // Older clients sent a country label. Accept known labels and historical
    // provider names, but never guess a country from arbitrary free text.
    const label = string(context.country, 120, 'country');
    if (label) {
      code = COUNTRY_BY_NAME.get(norm(label));
      if (!code || !COUNTRY_BY_CODE.has(code)) throw invalid();
    }
  }
  return { country_code: code, country: code ? COUNTRY_BY_CODE.get(code) : '' };
}
// Website is matching context only. Strip paths, queries and fragments before
// storing it or incorporating it in search queries; never fetch this field here.
function businessWebsite(value) {
  const raw = string(value, 2048, 'business website');
  if (!raw) return '';
  let website;
  try { website = new URL(raw); } catch { throw new ApiError(400, 'Enter a full business website URL, such as https://example.com.'); }
  const host = website.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(website.protocol) || website.username || website.password
    || (!host.includes('.') && !host.startsWith('[')) || /\.(?:local|localhost|internal|test|invalid)$/.test(host)
    || fetchAllowed(website.href).reason === 'private_host') {
    throw new ApiError(400, 'Enter a public business website URL without login details.');
  }
  website.hostname = host;
  return website.origin;
}
async function body(request) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new ApiError(415, 'Send JSON with Content-Type: application/json.');
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'Missing JSON body.');
  const chunks = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 256_000) { await reader.cancel(); throw new ApiError(413, 'Request is too large.'); }
    chunks.push(value);
  }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  try {
    const result = JSON.parse(new TextDecoder().decode(data));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result;
  } catch { throw new ApiError(400, 'Invalid JSON body.'); }
}
async function hashIp(request, env) {
  if (!env.IP_SALT) throw new ApiError(503, 'The scanner needs an IP_SALT setting before it can accept scans.');
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.IP_SALT}:${ip}`));
  return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function getScan(db, id) {
  if (!UUID.test(id)) throw new ApiError(404, 'Scan not found.');
  const row = await db.prepare('SELECT * FROM scans WHERE id = ?').bind(id).first();
  if (!row) throw new ApiError(404, 'Scan not found.');
  return scanData(row);
}
async function ownedHit(request, db, id) {
  const scanId = request.headers.get('X-Scan-Id') || '';
  await getScan(db, scanId);
  const hit = await db.prepare('SELECT * FROM hits WHERE id = ? AND scan_id = ?').bind(Number(id), scanId).first();
  if (!hit) throw new ApiError(404, 'Result not found in this scan.');
  return hit;
}
async function withLease(db, id, work) {
  const lease = await acquireLease(db, id);
  if (!lease) throw new ApiError(409, 'A scan step is running. Please try again in a moment.');
  try { return await work(); } finally { await releaseLease(db, id, lease); }
}

async function createScan(request, env) {
  const b = await body(request);
  const subjectType = b.subject_type === undefined ? 'person' : b.subject_type;
  if (!['person', 'business'].includes(subjectType)) throw new ApiError(400, 'Choose an individual or business scan.');
  const business = subjectType === 'business';
  const fullName = string(b.full_name, 80, business ? 'business name' : 'name', true);
  if (fullName.length < 2) throw new ApiError(400, 'Name must be between 2 and 80 characters.');
  if (b.attestation !== true) throw new ApiError(400, business ? 'Confirm that you own or are authorised to represent this business.' : 'Confirm that you are searching for yourself or your child.');
  if (typeof b.is_minor !== 'boolean') throw new ApiError(400, 'Choose whether the person is under 18.');
  if (business && b.is_minor) throw new ApiError(400, 'Use the individual scan for a person under 18.');
  const harms = list(b.harm_types, 8, 'harm types');
  if (harms.some(x => !HARMS.has(x))) throw new ApiError(400, 'Invalid harm type.');
  if (harms.some(x => ['sensitive_intimate', 'child_safety'].includes(x))) return json({ id: null, show_help_first: true, help_only: true });
  const variants = list(b.variants, 5, 'aliases');
  const c = b.context ?? {};
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new ApiError(400, 'Invalid context.');
  const context = { ...Object.fromEntries((business ? ['city', 'industry'] : ['city', 'employer', 'school']).map(k => [k, string(c[k], 120, k)])), ...countryContext(c) };
  context.subject_type = subjectType;
  if (business) {
    context.representative_name = string(c.representative_name, 80, 'representative name', true);
    if (context.representative_name.length < 2 || /[\r\n]/.test(context.representative_name)) throw new ApiError(400, 'Enter the representative’s name (2–80 characters).');
    context.website = businessWebsite(c.website);
  }
  context.usernames = list(c.usernames, 5, 'usernames');
  const email = string(b.email, 254, 'email');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'Enter a valid email address.');
  const provider = providerOf(env);
  if (!['mock', 'session', ...EXTERNAL].includes(provider)) throw new ApiError(503, 'Unknown search provider configuration.');
  const source = string(b.utm, 300, 'source');
  const ipHash = await hashIp(request, env), now = Date.now();
  // Older scans did not apply their country labels to search requests. Version
  // the identity so new country-aware scans cannot reuse those results.
  const websiteHost = context.website ? new URL(context.website).hostname.replace(/^www\./, '') : '';
  const nameNorm = `country:v1:${JSON.stringify([subjectType, norm(fullName), context.country_code,
    ...(business ? [websiteHost, norm(context.representative_name), email.toLowerCase()] : [])])}`;
  const recentScan = () => env.DB.prepare('SELECT id, is_minor FROM scans WHERE name_norm = ? AND ip_hash = ? AND provider = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1').bind(nameNorm, ipHash, provider, now - 864e5).first();
  const reuse = async existing => {
    // Reusing a prior scan must never override a newly declared minor status.
    if (b.is_minor && !existing.is_minor) await env.DB.prepare('UPDATE scans SET is_minor = 1 WHERE id = ?').bind(existing.id).run();
    return json({ id: existing.id, show_help_first: Boolean(existing.is_minor || b.is_minor), reused: true });
  };
  const existing = await recentScan();
  if (existing) return reuse(existing);
  const day = new Date(now).toISOString().slice(0, 10);
  const limit = Math.max(0, Number(env.SCANS_PER_IP_PER_DAY ?? 50));
  await env.DB.prepare('INSERT OR IGNORE INTO ip_daily (day, ip_hash, scans) VALUES (?, ?, 0)').bind(day, ipHash).run();
  const id = crypto.randomUUID();
  // D1 batches are transactional: competing requests recheck reuse and the
  // remaining allowance when inserting, and charge only their own new scan.
  const [inserted] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO scans (id, created_at, full_name, name_norm, variants_json, context_json, email, is_minor, harm_types_json, provider, ip_hash, utm)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM scans WHERE name_norm = ? AND ip_hash = ? AND provider = ? AND created_at > ?)
        AND EXISTS (SELECT 1 FROM ip_daily WHERE day = ? AND ip_hash = ? AND scans < ?)`)
      .bind(id, now, fullName, nameNorm, JSON.stringify(variants), JSON.stringify(context), email || null, b.is_minor ? 1 : 0, JSON.stringify(harms), provider, ipHash, source,
        nameNorm, ipHash, provider, now - 864e5, day, ipHash, limit),
    env.DB.prepare('UPDATE ip_daily SET scans = scans + 1 WHERE day = ? AND ip_hash = ? AND EXISTS (SELECT 1 FROM scans WHERE id = ?)').bind(day, ipHash, id),
  ]);
  if (!inserted.meta.changes) {
    const competingScan = await recentScan();
    if (competingScan) return reuse(competingScan);
    throw new ApiError(429, 'Daily scan limit reached. Please try again tomorrow.');
  }
  return json({ id, show_help_first: b.is_minor }, 201);
}

async function report(env, id) {
  const scan = await getScan(env.DB, id);
  const hits = await rows(env.DB, 'SELECT * FROM hits WHERE scan_id = ? ORDER BY id', id);
  const safe = hits.filter(h => h.category !== 'sensitive_intimate');
  const ranked = rankHits(safe, Math.min(10, Math.max(1, Number(env.SHOW_LIMIT) || 10)));
  const publicHit = h => {
    const { context_text, source_query, canonical_url, scan_id, ...rest } = h;
    return { ...rest, category_label: scan.subject_type === 'business' && h.category === 'same_name_other_person' ? 'Different business with the same name' : CATEGORY_LABELS[h.category] || 'Review needed' };
  };
  const queries = await rows(env.DB, 'SELECT id, q, priority, status FROM queries WHERE scan_id = ? ORDER BY priority, id', id);
  return json({ id, status: scan.status, error: scan.error, full_name: scan.full_name, subject_type: scan.subject_type, provider: scan.provider, is_minor: Boolean(scan.is_minor),
    progress: { total: queries.length, completed: queries.filter(q => q.status !== 'pending').length, classified: hits.filter(h => h.classified).length, hits: hits.length },
    shown: ranked.shown.map(publicHit), moreCount: ranked.moreCount, sameNameCount: ranked.sameNameCount,
    sameName: safe.filter(h => h.classified && (h.category === 'same_name_other_person' || h.match_confidence < 0.3)).slice(0, 10).map(publicHit),
    notMe: safe.filter(h => h.status === 'not_me').slice(0, 10).map(publicHit),
    helpRequired: hits.some(h => h.category === 'sensitive_intimate'),
    usage: { serp_queries: scan.serp_queries, in_tokens: scan.in_tokens, out_tokens: scan.out_tokens, cost_usd: scan.cost_usd },
    ...(scan.status === 'awaiting_import' ? { queries: queries.filter(q => q.status === 'pending') } : {}),
  });
}

async function importResults(request, env, id) {
  const scan = await getScan(env.DB, id), b = await body(request);
  if (scan.provider !== 'session') throw new ApiError(400, 'Imports are available in session mode only.');
  if (!Array.isArray(b.results) || b.results.length > 20) throw new ApiError(400, 'Import up to 20 query results at a time.');
  const imports = b.results.map(result => {
    if (!result || !Array.isArray(result.items) || result.items.length > 20) throw new ApiError(400, 'Invalid imported items.');
    return { q: string(result.q, 500, 'query', true), items: result.items.map(item => ({ title: string(item?.title, 300, 'title'), snippet: string(item?.snippet, 1000, 'snippet'), url: string(item?.url, 2048, 'URL', true) })) };
  });
  return withLease(env.DB, id, async () => {
    // Validate the whole batch before making changes, then accept only pending queries.
    for (const result of imports) if (!(await env.DB.prepare('SELECT id FROM queries WHERE scan_id = ? AND q = ?').bind(id, result.q).first())) throw new ApiError(400, 'Import contains a query that does not belong to this scan.');
    let inserted = 0;
    for (const result of imports) {
      const query = await env.DB.prepare("SELECT id FROM queries WHERE scan_id = ? AND q = ? AND status = 'pending'").bind(id, result.q).first();
      if (!query) continue;
      const n = await insertHits(env, scan, result.items, result.q); inserted += n;
      await env.DB.prepare("UPDATE queries SET status = 'done', results = ? WHERE id = ?").bind(n, query.id).run();
    }
    return json({ imported: inserted });
  });
}

async function draft(request, env, hitId) {
  const hit = await ownedHit(request, env.DB, hitId), scan = await getScan(env.DB, hit.scan_id), b = await body(request);
  if (b.owns_content !== undefined && typeof b.owns_content !== 'boolean') throw new ApiError(400, 'Invalid content ownership choice.');
  if (hit.category === 'sensitive_intimate') return json({ help_only: true, templates: [], draft: null });
  const eligible = templatesFor(hit, { isMinor: Boolean(scan.is_minor), ownsContent: b.owns_content === true, subjectType: scan.subject_type });
  const templateList = eligible.map(id => ({ id, label: TEMPLATES[id].label }));
  if (b.template && !eligible.includes(b.template)) throw new ApiError(400, 'That request template is not available for this result.');
  const channel = hit.kind === 'autocomplete'
    ? { name: 'Google search suggestions', form: 'https://support.google.com/websearch/answer/106230', how: 'Use Report inappropriate predictions below the search box. A suggestion does not establish that an allegation is true.' }
    : platformFor(hit.url);
  const google = googleChannelFor(hit.category);
  const abuse = channel ? null : scan.provider === 'mock'
    ? { registrar: 'Example registrar (fixture)', registrarAbuse: 'abuse@registrar.example', host: 'Example host (fixture)', hostAbuse: 'abuse@host.example', cloudflare: null }
    : await lookupAbuse(hit.url);
  if (!b.template) return json({ channel, google, abuse, templates: templateList, draft: null });
  return withLease(env.DB, scan.id, async () => {
    if (cloudAiEnabled(env) && scan.provider !== 'mock' && !(await checkBudget(env, env.DB)).ok) throw new ApiError(429, 'Daily drafting budget reached. Please try again tomorrow.');
    const draftEnv = scan.provider === 'mock' ? { ...env, CLOUD_AI_ENABLED: 'false', ANTHROPIC_API_KEY: '' } : env;
    const result = await draftRequest(draftEnv, scan, { ...hit, owns_content: b.owns_content === true }, b.template, channel || abuse);
    await env.DB.prepare("UPDATE hits SET status = CASE WHEN status = 'found' THEN 'drafted' ELSE status END WHERE id = ?").bind(hit.id).run();
    return json({ channel, google, abuse, templates: templateList, draft: result });
  });
}

async function contact(request, env, kind) {
  const b = await body(request), scanId = string(b.scan_id, 40, 'scan ID');
  if (scanId) await getScan(env.DB, scanId);
  const name = string(b.name ?? b.full_name, 80, 'name', true), email = string(b.email, 254, 'email', true);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, 'Enter a valid email address.');
  const helpType = b.help_type || 'unsure';
  if (!['legal', 'investigator', 'pr', 'unsure'].includes(helpType)) throw new ApiError(400, 'Invalid help type.');
  const message = string(b.message, 3000, 'message');
  const hitIds = b.hit_ids ?? [];
  if (!Array.isArray(hitIds) || hitIds.length > 10 || hitIds.some(x => !Number.isSafeInteger(x) || x < 1)) throw new ApiError(400, 'Invalid result IDs.');
  for (const hitId of hitIds) if (!(await env.DB.prepare('SELECT id FROM hits WHERE id = ? AND scan_id = ?').bind(hitId, scanId).first())) throw new ApiError(400, 'Result does not belong to this scan.');
  await env.DB.prepare(`INSERT INTO requests (scan_id, kind, help_type, name, email, message, hit_ids_json, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ? IS NULL OR EXISTS (SELECT 1 FROM scans WHERE id = ?)`)
    .bind(scanId || null, kind, helpType, name, email, message, JSON.stringify(hitIds), Date.now(), scanId || null, scanId || null).run();
  return json({ ok: true, message: 'Your request has been saved for review. No message has been sent to a partner.' }, 201);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/$/, ''), method = request.method;
    if (!path.startsWith('/api/') && path !== '/api') return env.ASSETS.fetch(request);
    try {
      const origin = request.headers.get('Origin');
      if (origin && origin !== new URL(request.url).origin) throw new ApiError(403, 'Cross-origin requests are not allowed.');
      if (path === '/api/takedowns' || path.startsWith('/api/takedowns/')) return await handleTakedowns(request, env, path, {
        json, readBody: body, text: string, hashIp, fail: (status, message) => { throw new ApiError(status, message); },
      });
      if (path === '/api/config' && method === 'GET') return json({ demo: providerOf(env) === 'mock', cloud_ai_enabled: providerOf(env) !== 'mock' && cloudAiEnabled(env) });
      if (path === '/api/help-links' && method === 'GET') return json({ links: HELP_LINKS });
      if (path === '/api/scan' && method === 'POST') return await createScan(request, env);
      let match = path.match(/^\/api\/scan\/([^/]+)(?:\/(queries|import|retry))?$/);
      if (match) {
        const [, id, action] = match;
        await getScan(env.DB, id);
        if (!action && method === 'GET') { await stepScan(env, id); return await report(env, id); }
        if (action === 'queries' && method === 'GET') {
          const scan = await getScan(env.DB, id);
          if (scan.provider !== 'session') throw new ApiError(400, 'Query export is available in session mode only.');
          return json({ queries: await rows(env.DB, "SELECT q, priority, source FROM queries WHERE scan_id = ? AND status = 'pending' ORDER BY priority, id", id) });
        }
        if (action === 'import' && method === 'POST') return await importResults(request, env, id);
        if (action === 'retry' && method === 'POST') return await withLease(env.DB, id, async () => {
          const scan = await getScan(env.DB, id);
          if (!['error', 'paused_budget'].includes(scan.status)) throw new ApiError(400, 'This scan does not need a retry.');
          const q = await env.DB.prepare('SELECT COUNT(*) AS n FROM queries WHERE scan_id = ?').bind(id).first();
          const status = q.n ? (scan.provider === 'session' ? 'awaiting_import' : 'searching') : 'planning';
          await env.DB.prepare('UPDATE scans SET status = ?, error = NULL WHERE id = ?').bind(status, id).run(); return json({ ok: true });
        });
        if (!action && method === 'DELETE') return await withLease(env.DB, id, async () => {
          await env.DB.batch([
            env.DB.prepare('DELETE FROM serp_cache WHERE key IN (SELECT cache_key FROM scan_cache WHERE scan_id = ?)').bind(id),
            ...['scan_cache', 'drafts', 'requests', 'hits', 'queries'].map(table => env.DB.prepare(`DELETE FROM ${table} WHERE scan_id = ?`).bind(id)),
            env.DB.prepare('DELETE FROM scans WHERE id = ?').bind(id),
          ]); return json({ deleted: true });
        });
      }
      match = path.match(/^\/api\/hit\/(\d+)(?:\/(draft))?$/);
      if (match) {
        if (method === 'POST' && match[2]) return await draft(request, env, match[1]);
        if (method === 'PATCH' && !match[2]) {
          const hit = await ownedHit(request, env.DB, match[1]), b = await body(request);
          if (!STATUSES.has(b.status)) throw new ApiError(400, 'Invalid result status.');
          await env.DB.prepare('UPDATE hits SET status = ? WHERE id = ? AND scan_id = ?').bind(b.status, hit.id, hit.scan_id).run();
          return json({ id: hit.id, status: b.status });
        }
      }
      if (['/api/help', '/api/unlock'].includes(path) && method === 'POST') return await contact(request, env, path.slice(5));
      throw new ApiError(404, 'API route not found.');
    } catch (error) { return json({ error: error instanceof ApiError ? error.message : 'The request could not be completed. Please try again.' }, error instanceof ApiError ? error.status : 500); }
  },
};
