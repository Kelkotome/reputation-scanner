// Active server boundary for browser-owned scans and cases. Explicit assistance,
// short-lived encrypted email credentials/receipts, access metadata and totals persist.
import { providerOf, EXTERNAL, search, autocomplete } from './serp.js';
import { COUNTRIES } from './countries.js';
import { HELP_LINKS } from './platforms.js';
import { validateSearxngConfiguration, configuredSearxngEngines } from './searxng.js';
import { recoverMissingGoogle } from './searxng-recovery.js';
import { SEARCH_RESULT_LIMIT, VISIBLE_RESULT_LIMIT, safeSearchEngines } from './search-limits.js';
import { ApiError, fail, operatorSession, loginOperator, logoutOperator, nextUtc, isAdmin } from './operator-access.js';
import { partnerLogin, requireAdminAccess, partnerRemaining, listPartners, savePartner, removePartner } from './partners.js';
import { PUBLIC_DAILY_LIMIT, publicMaxQueries, startSearchSession, validateRelayPermit, reserveRelay, finishRelay, usageDashboard, cleanupTransientUsage } from './quota-usage.js';
import { abuseConfig, protectAssistance, acquireRelayLease, releaseRelayLease } from './public-abuse.js';
import { emailRoute, emailCallback, cleanupEmail, runEmailFollowups } from './email.js';
import { reportingContactRoute } from './reporting-contact.js';
import { EmailMessage } from 'cloudflare:email';
import { sendAssistanceEmail } from './assistance-mail.js';
import { aiConfig, aiDraftRoute, aiUsage } from './ai-draft.js';

const COUNTRY_CODES = new Set(COUNTRIES.map(country => country.code));
const MAX_BODY_BYTES = 32 * 1024;
const SENSITIVE_QUERY = /\b(?:nudes?|nudity|naked|porn(?:ography|ographic)?|sex(?:ual)?[\s-]*(?:tapes?|videos?|images?|abuse)|intimate[\s-]+(?:images?|content|videos?)|revenge[\s-]+porn|child[\s-]+(?:sexual|abuse)|onlyfans|fansly|nsfw|xxx|xvideos?|xnxx|xhamster|hentai)\b|裸照|色情/i;
const RETIRED = /^\/api\/(?:scan|hit|takedowns|import|help|unlock)(?:\/|$)/;
const json = (data, status = 200, extraHeaders = {}) => new Response(JSON.stringify(data), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...extraHeaders,
} });

function exactObject(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowed.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) fail(400, 'Unexpected or missing request fields.');
  return value;
}
function text(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, `Enter a valid ${label}.`);
  const clean = value.trim();
  if (required && !clean) fail(400, `Enter a valid ${label}.`);
  return clean;
}
function publicUrl(value) {
  const raw = text(value, 2048, 'public HTTP(S) URL', true);
  if (/[\u0000-\u001f\u007f]/.test(raw)) fail(400, 'Enter a valid public HTTP(S) URL.');
  let url;
  try { url = new URL(raw); } catch { fail(400, 'Enter a valid public HTTP(S) URL.'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || !host.includes('.') || host.startsWith('[') || /(^|\.)(localhost|local|internal)$/.test(host)) fail(400, 'Enter a valid public HTTP(S) URL.');
  if (/^\d+(\.\d+){3}$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
      || (a === 100 && b >= 64 && b <= 127)) fail(400, 'Enter a valid public HTTP(S) URL.');
  }
  return url.href;
}
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) fail(415, 'Send a JSON request.');
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) fail(413, 'Request is too large.');
  if (!request.body) fail(400, 'Send a JSON request body.');
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); fail(413, 'Request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail(400, 'Send valid JSON.'); }
}
function sameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  const site = request.headers.get('Sec-Fetch-Site');
  if ((origin !== null && origin !== url.origin) || (site && !['same-origin', 'none'].includes(site))) fail(403, 'Cross-origin requests are not allowed.');
}
// Admin-only routes need the operator key session and, when configured, the
// Cloudflare Access admin sign-in. Partner sessions never pass.
async function requireAdmin(request, env) {
  if (!isAdmin(await operatorSession(request, env))) fail(401, 'Sign in to view operator usage.');
  await requireAdminAccess(request, env);
}
function boundedLimit(value, fallback, maximum) {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n >= 0 ? Math.min(maximum, Math.floor(n)) : fallback;
}
function relayEnabled(env) { return env.ALLOW_SEARCH_RELAY === 'true' && EXTERNAL.has(providerOf(env)); }
function requireSearchProvider(env) {
  if (providerOf(env) === 'searxng') {
    try { validateSearxngConfiguration(env); }
    catch { fail(503, 'The search provider is not configured.'); }
  } else if (!env.SERP_API_KEY) fail(503, 'The search provider is not configured.');
}
function googleBackup(env) {
  const selected = providerOf(env) === 'searxng' && env.GOOGLE_BACKUP_PROVIDER === 'serpapi';
  const key = typeof env.SERPAPI_API_KEY === 'string' ? env.SERPAPI_API_KEY.trim() : '';
  const available = selected && key.length > 0 && key.length <= 1024 && !/[^\u0021-\u007e]/.test(key);
  return { selected, available, key };
}

function providerText(value, maximum) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maximum) : '';
}
async function relay(request, env) {
  // This check precedes body parsing, database access and every external call.
  if (!relayEnabled(env)) fail(403, 'Live search sharing is disabled. Your scan remains in this browser.');
  const b = exactObject(await readBody(request), ['q', 'country_code', 'kind', 'search_ticket', 'page', 'google_backup_consent'], ['q', 'country_code', 'kind']);
  if (b.google_backup_consent !== undefined && typeof b.google_backup_consent !== 'boolean') fail(400, 'Confirm whether Google backup queries may be shared.');
  const q = text(b.q, 500, 'search query', true);
  if (SENSITIVE_QUERY.test(q.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, ''))) fail(400, 'Use the specialist help resources for intimate-content concerns.');
  if (!['search', 'autocomplete'].includes(b.kind)) fail(400, 'Choose a valid search kind.');
  if (typeof b.country_code !== 'string') fail(400, 'Choose a country from the list.');
  let country = b.country_code.trim().toLowerCase();
  if (country === 'gb') country = 'uk';
  if (country && !COUNTRY_CODES.has(country)) fail(400, 'Choose a country from the list.');
  const provider = providerOf(env);
  const backup = googleBackup(env), useBackup = backup.available && b.google_backup_consent === true;
  const page = b.page === undefined ? 1 : b.page;
  if (!Number.isInteger(page) || page < 1 || page > 3 || (b.page !== undefined && (provider !== 'searxng' || b.kind !== 'search'))) fail(400, 'Choose a supported search page (1–3).');
  if (provider === 'searxng' && b.kind === 'autocomplete') return json({ suggestions: [] });
  requireSearchProvider(env);
  const operator = await operatorSession(request, env);
  // Invalid or exhausted tickets never occupy provider capacity. Reservation
  // still rechecks after acquiring the lease to handle concurrent requests.
  await validateRelayPermit(request, env, operator, b.search_ticket, provider);
  const lease = await acquireRelayLease(request, env, operator);
  const startedAt = Date.now();
  // Leave room for both bounded providers; a slow primary must not consume the
  // independent backup's entire deadline.
  const relayDeadlineMs = useBackup ? 28000 : 15000;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), relayDeadlineMs);
  let reservation;
  try { reservation = await reserveRelay(request, env, operator, b.search_ticket, provider); }
  catch (error) { clearTimeout(timer); await releaseRelayLease(env, lease); throw error; }
  let providerFailed = false, completed = false;
  const fetchProvider = async (url, options = {}) => {
    // Workers only implement manual/follow. Reject redirects here for every
    // provider so query text and credentials cannot reach another endpoint.
    let response;
    if (controller.signal.aborted) throw new Error('provider_timeout');
    try { response = await fetch(url, { ...options,
      signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal, redirect: 'manual' }); }
    catch (error) { providerFailed = true; throw error; }
    if (!response.ok) providerFailed = true;
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('provider_redirect');
    }
    return response;
  };
  try {
    const providerEnv = { ...env, SERP_GL: country };
    if (b.kind === 'autocomplete') {
      const suggestions = await autocomplete(providerEnv, q, fetchProvider, { strict: true });
      if (providerFailed) throw new Error('provider_failed');
      completed = true; await finishRelay(env, reservation, true);
      return json({ suggestions: (Array.isArray(suggestions) ? suggestions : []).slice(0, 20)
        .map(value => providerText(value, 500)).filter(Boolean) });
    }
    let first, primaryFailed = false;
    try { first = await search(providerEnv, q, fetchProvider, { page }); }
    catch (error) {
      if (!useBackup) throw error;
      primaryFailed = true;
      first = { results: [], related: [], partial: true, coverage: { returned: 0, invalid: 0, limited: 0, engines: [] } };
    }
    const data = provider === 'searxng' ? await recoverMissingGoogle(providerEnv, q, first, {
      page, fetchImpl: fetchProvider,
      ...(useBackup ? { backupProvider: 'serpapi',
        searchImpl: (_retryEnv, query, fetchImpl, options) => search({ ...providerEnv, SERP_PROVIDER: 'serpapi', SERP_API_KEY: backup.key }, query, fetchImpl, options),
      } : {}),
      reserve: () => useBackup
        ? reserveRelay(request, env, operator, b.search_ticket, provider, {
          usageProvider: 'serpapi', costPer1000: env.GOOGLE_BACKUP_COST_PER_1K?.trim() ? Number(env.GOOGLE_BACKUP_COST_PER_1K) : 0,
          dailyProviderLimit: Number(env.GOOGLE_BACKUP_DAILY_LIMIT ?? 50),
        }) : reserveRelay(request, env, operator, b.search_ticket, provider),
      finish: (attempt, success) => finishRelay(env, attempt, success),
      remainingMs: () => Math.max(0, relayDeadlineMs - 200 - (Date.now() - startedAt)),
    }) : first;
    const incoming = Array.isArray(data.results) ? data.results : [], results = [];
    const upstream = ['searxng', 'serpapi', 'serper'].includes(provider) ? data.coverage : null;
    // Count only a structurally valid adapter summary. Other providers use the
    // entries their adapter returned; no arbitrary provider metadata is copied.
    const trustedCoverage = upstream && ['returned', 'invalid', 'limited'].every(key => Number.isSafeInteger(upstream[key]) && upstream[key] >= 0)
      && upstream.returned === incoming.length + upstream.invalid + upstream.limited;
    const coverage = trustedCoverage ? { returned: upstream.returned, invalid: upstream.invalid, limited: upstream.limited,
      engines: safeSearchEngines(upstream.engines) } : { returned: incoming.length, invalid: 0, limited: 0, engines: [] };
    if (trustedCoverage && ['recovered', 'empty', 'failed', 'budget_skipped', 'time_skipped'].includes(upstream.google_recovery)
      && [1, 2].includes(upstream.attempts)) {
      coverage.google_recovery = upstream.google_recovery;
      coverage.attempts = upstream.attempts;
      if (useBackup && upstream.google_backup_provider === 'serpapi') coverage.google_backup_provider = 'serpapi';
    }
    if (primaryFailed) coverage.primary_failed = true;
    for (const item of incoming) {
      try {
        const result = { title: providerText(item?.title, 500), url: publicUrl(item?.url), snippet: providerText(item?.snippet, 2000) };
        if (results.length >= SEARCH_RESULT_LIMIT) coverage.limited++;
        else results.push(result);
      }
      catch { coverage.invalid++; /* Drop malformed provider links without exposing raw metadata. */ }
    }
    completed = true; await finishRelay(env, reservation, !primaryFailed && first.partial !== true);
    return json({ results, related: [], coverage, ...(data.partial === true ? { partial: true } : {}) });
  } catch {
    if (!completed) await finishRelay(env, reservation, false);
    fail(502, 'The search provider could not complete this request. Please try again later.');
  } finally { clearTimeout(timer); await releaseRelayLease(env, lease); }
}
function attachment(value) {
  const b = exactObject(value, ['subject_name', 'subject_type', 'country', 'results'], ['subject_name', 'subject_type', 'country', 'results']);
  const subject_name = text(b.subject_name, 80, 'subject name', true);
  if (!['person', 'business'].includes(b.subject_type)) fail(400, 'Choose a valid subject type.');
  const country = text(b.country, 120, 'country');
  if (!Array.isArray(b.results) || b.results.length > VISIBLE_RESULT_LIMIT) fail(400, `Share at most ${VISIBLE_RESULT_LIMIT} selected results.`);
  const results = b.results.map(value => {
    const result = exactObject(value, ['url', 'title'], ['url', 'title']);
    return { url: publicUrl(result.url), title: text(result.title, 500, 'result title') };
  });
  return { subject_name, subject_type: b.subject_type, country, results };
}
const MAX_SHARED_LINKS = 20;
function sharedLinks(value) {
  // Links the user chooses to send, including private or non-indexed pages such
  // as Telegram groups. They are emailed to the team and never fetched here.
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SHARED_LINKS) fail(400, `Share at most ${MAX_SHARED_LINKS} links.`);
  return [...new Set(value.map(publicUrl))];
}
async function assistance(request, env) {
  const b = exactObject(await readBody(request), ['consent', 'name', 'email', 'message', 'help_type', 'share_report', 'attachment', 'links', 'challenge_token'], ['consent', 'name', 'email', 'message', 'help_type']);
  if (b.consent !== true) fail(400, 'Confirm that you want to share this assistance request.');
  if (b.share_report !== undefined && typeof b.share_report !== 'boolean') fail(400, 'Choose whether to share selected report details.');
  if (b.share_report !== true && Object.hasOwn(b, 'attachment')) fail(400, 'Confirm sharing before attaching report details.');
  const name = text(b.name, 80, 'name', true), email = text(b.email, 254, 'email address', true);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
  const message = text(b.message, 3000, 'message');
  if (!['legal', 'investigator', 'pr', 'unsure'].includes(b.help_type)) fail(400, 'Choose a valid help type.');
  const shared = b.share_report === true ? attachment(b.attachment) : null;
  const links = sharedLinks(b.links);
  await protectAssistance(request, env, await operatorSession(request, env), b.challenge_token);
  const id = crypto.randomUUID(), createdAt = Date.now();
  const partners = 'Partner organisations are contacted only with your agreement.';
  if (await sendAssistanceEmail(env, { id, createdAt, helpType: b.help_type, name, email, message, links, attachment: shared }, EmailMessage)) {
    // Delivered: keep only a content-free receipt (purged after 30 days).
    try {
      await env.DB.prepare(`INSERT INTO assistance_requests
        (id, created_at, name, email, message, help_type, attachment_json, links_json, consent_version, delivered) VALUES (?, ?, '', '', '', ?, NULL, NULL, ?, 1)`)
        .bind(id, createdAt, b.help_type, 'assistance-v2').run();
    } catch { /* The email already reached the team; a missing receipt loses nothing. */ }
    return json({ ok: true, delivered: true, request_id: id,
      message: `Your request was sent to the 123 Reputation Management team. We will reply to the email address you gave. ${partners}` }, 201);
  }
  // Not delivered (binding absent or send failed): keep the request so it is
  // not lost. Undelivered rows are purged after 30 days.
  await env.DB.prepare(`INSERT INTO assistance_requests
    (id, created_at, name, email, message, help_type, attachment_json, links_json, consent_version, delivered) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`)
    .bind(id, createdAt, name, email, message, b.help_type, shared ? JSON.stringify(shared) : null, links.length ? JSON.stringify(links) : null, 'assistance-v2').run();
  return json({ ok: true, delivered: false, request_id: id,
    message: `Your request was received and saved for the 123 Reputation Management team to review. We will reply to the email address you gave. ${partners}` }, 201);
}

export default {
  async scheduled(_event, env) { await runEmailFollowups(env); await cleanupTransientUsage(env); await cleanupEmail(env); },
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, ''), method = request.method;
    if (!path.startsWith('/api/') && path !== '/api') return env.ASSETS.fetch(request);
    // Old IDs can never revive server-backed scans, even with an old client.
    if (RETIRED.test(path)) return json({ error: 'Scans and cases are now saved only in this browser. This server storage API is retired.' }, 410);
    try {
      // OAuth redirects are cross-site top-level GETs and carry provider query
      // parameters. The callback enforces its own origin, one-use state and cookie.
      if (/^\/api\/email\/callback\/(gmail|outlook)$/.test(path)) return await emailCallback(request, env);
      // Partner sign-in arrives as a top-level redirect from Cloudflare Access.
      if (path === '/api/partner/login') return await partnerLogin(request, env);
      sameOrigin(request, url);
      if (url.search) fail(400, 'API requests must not include URL query parameters.');
      if (path.startsWith('/api/email/')) return await emailRoute(request, env, readBody);
      if (path === '/api/reporting-contact') return await reportingContactRoute(request, env, readBody);
      if (path === '/api/config' && method === 'GET') {
        const operator = await operatorSession(request, env), admin = isAdmin(operator);
        const partner = operator && !admin ? { email: operator.email, organisation: operator.organisation, daily_limit: operator.daily_limit,
          remaining_scans: await partnerRemaining(env, operator) } : null;
        return json({ storage: 'browser', operator: admin, partner, public_daily_limit: PUBLIC_DAILY_LIMIT, ...abuseConfig(request, env, operator),
        scan_ticket_required: EXTERNAL.has(providerOf(env)), quota_reset_hour_utc: 0, reset_at: nextUtc(),
        demo: providerOf(env) === 'mock', provider: providerOf(env), cloud_ai_enabled: false, ...aiConfig(env),
        search_relay_enabled: relayEnabled(env), search_country_supported: providerOf(env) !== 'searxng',
        ...(providerOf(env) === 'searxng' ? { search_engines: configuredSearxngEngines(env),
          google_backup_provider: googleBackup(env).selected ? 'serpapi' : null,
          google_backup_available: googleBackup(env).available } : {}),
        autocomplete_supported: ['serper', 'serpapi', 'mock'].includes(providerOf(env)),
        max_queries: admin ? 60 : publicMaxQueries(env), show_limit: boundedLimit(env.SHOW_LIMIT, VISIBLE_RESULT_LIMIT, VISIBLE_RESULT_LIMIT) });
      }
      if (path === '/api/operator/session' && method === 'GET') {
        const operator = await operatorSession(request, env);
        if (operator && !isAdmin(operator)) return json({ operator: false, expires_at: operator.expires_at,
          partner: { email: operator.email, organisation: operator.organisation, daily_limit: operator.daily_limit, remaining_scans: await partnerRemaining(env, operator) } });
        return json(operator ? { operator: true, expires_at: operator.expires_at } : { operator: false });
      }
      if (path === '/api/operator/login' && method === 'POST') {
        const body = exactObject(await readBody(request), ['access_key'], ['access_key']);
        await requireAdminAccess(request, env);
        const result = await loginOperator(request, env, body.access_key);
        return json(result.data, 200, { 'Set-Cookie': result.cookie });
      }
      if (path === '/api/operator/logout' && method === 'POST') {
        exactObject(await readBody(request), []);
        const result = await logoutOperator(request, env);
        return json(result.data, 200, { 'Set-Cookie': result.cookie });
      }
      if (path === '/api/operator/usage' && method === 'GET') {
        await requireAdmin(request, env);
        return json({ ...await usageDashboard(env, providerOf(env)), ai_drafting: await aiUsage(env) });
      }
      if (path === '/api/operator/partners' && method === 'GET') { await requireAdmin(request, env); return json(await listPartners(env)); }
      if (path === '/api/operator/partners' && method === 'POST') {
        const body = exactObject(await readBody(request), ['email', 'organisation', 'daily_limit'], ['email', 'organisation']);
        await requireAdmin(request, env);
        return json(await savePartner(env, body));
      }
      if (path === '/api/operator/partners/remove' && method === 'POST') {
        const body = exactObject(await readBody(request), ['email'], ['email']);
        await requireAdmin(request, env);
        return json(await removePartner(env, body));
      }
      if (path === '/api/search-session' && method === 'POST') {
        if (!relayEnabled(env)) fail(403, 'Live search sharing is disabled. Your scan remains in this browser.');
        const body = exactObject(await readBody(request), ['request_id', 'challenge_token'], ['request_id']);
        requireSearchProvider(env);
        const operator = await operatorSession(request, env);
        return json(await startSearchSession(request, env, operator, body.request_id, providerOf(env), body.challenge_token));
      }
      if (path === '/api/help-links' && method === 'GET') return json({ links: HELP_LINKS });
      if (path === '/api/search' && method === 'POST') return await relay(request, env);
      if (path === '/api/assistance' && method === 'POST') return await assistance(request, env);
      // Opt-in AI drafting. Returns the draft only; nothing about it is stored.
      if (path === '/api/draft-ai' && method === 'POST') return json(await aiDraftRoute(request, env, { readBody, operatorSession, searchProvider: providerOf(env) }));
      fail(404, 'API route not found.');
    } catch (error) {
      return json({ error: error instanceof ApiError ? error.message : 'The request could not be completed. Please try again.', ...(error instanceof ApiError ? error.details : {}) }, error instanceof ApiError ? error.status : 500,
        error instanceof ApiError && error.details.retry_after_seconds ? { 'Retry-After': String(error.details.retry_after_seconds) } : {});
    }
  },
};
