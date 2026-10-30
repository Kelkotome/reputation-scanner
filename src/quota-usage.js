import { dailyIpHash, keyedHash, digest, utcDay, nextUtc, fail } from './operator-access.js';
import { abuseEnabled, protectPermitStart, cleanupAbuseMetadata } from './public-abuse.js';
import { EXTERNAL } from './serp.js';
import { reservePartnerScan, partnerRemaining } from './partners.js';

export const PUBLIC_DAILY_LIMIT = 3;
export function publicMaxQueries(env) {
  const n = Number(env.MAX_QUERIES ?? 12);
  return Number.isFinite(n) && n >= 1 ? Math.min(60, Math.floor(n)) : 12;
}
function searchCost(env) {
  const cost = Number(env.SERP_COST_PER_1K ?? 1) / 1000;
  if (!Number.isFinite(cost) || cost < 0) fail(503, 'Search cost estimates are not configured.');
  return cost;
}
function accountingOptions(provider, options) {
  if (options === undefined) return { usageProvider: provider, costPer1000: undefined, dailyProviderLimit: null };
  const invalid = () => fail(503, 'Search accounting is not configured.');
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    || Object.keys(options).some(key => !['usageProvider', 'costPer1000', 'dailyProviderLimit'].includes(key))) invalid();
  const usageProvider = options.usageProvider === undefined ? provider : options.usageProvider;
  if (options.usageProvider !== undefined && !EXTERNAL.has(usageProvider)) invalid();
  const costPer1000 = options.costPer1000;
  if (costPer1000 !== undefined && (typeof costPer1000 !== 'number' || !Number.isFinite(costPer1000) || costPer1000 < 0)) invalid();
  const dailyProviderLimit = options.dailyProviderLimit === undefined ? null : options.dailyProviderLimit;
  if (dailyProviderLimit !== null && (!Number.isSafeInteger(dailyProviderLimit) || dailyProviderLimit < 0)) invalid();
  if (options.dailyProviderLimit === null) invalid();
  return { usageProvider, costPer1000, dailyProviderLimit };
}
export async function cleanPrivateMetadata(env, now = Date.now()) {
  const yesterday = utcDay(now - 86400000), oldest = utcDay(now - 29 * 86400000);
  await env.DB.prepare('DELETE FROM operator_sessions WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare('DELETE FROM operator_login_limits WHERE day < ?').bind(yesterday).run();
  await env.DB.prepare('DELETE FROM search_permits WHERE day < ?').bind(yesterday).run();
  await env.DB.prepare('DELETE FROM private_usage_summary WHERE day < ?').bind(oldest).run();
  // AI drafting keeps only daily counters (no prompts or drafts), for 30 days.
  await env.DB.prepare('DELETE FROM ai_draft_usage WHERE day < ?').bind(oldest).run();
  // Partner scan counts (no queries or names) are kept for 30 days.
  await env.DB.prepare('DELETE FROM partner_usage WHERE day < ?').bind(oldest).run();
  // Assistance receipts and undelivered requests are kept for 30 days at most.
  await env.DB.prepare('DELETE FROM assistance_requests WHERE created_at < ?').bind(now - 30 * 86400000).run();
  await cleanupAbuseMetadata(env, now);
}
export const cleanupTransientUsage = cleanPrivateMetadata;
async function usageRow(env, day, mode, provider) {
  await env.DB.prepare('INSERT INTO private_usage_summary (day, mode, provider) VALUES (?, ?, ?) ON CONFLICT(day, mode, provider) DO NOTHING').bind(day, mode, provider).run();
}
export async function startSearchSession(request, env, operator, requestId, provider, challengeToken) {
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) fail(400, 'Send a separate random request ID.');
  const now = Date.now(), day = utcDay(now), mode = operator ? 'operator' : 'public';
  const owner = operator ? operator.token_hash : await dailyIpHash(request, env, now);
  const ticket = await keyedHash(env, 'search-permit', day, mode, owner, provider, requestId.toLowerCase());
  const ticketHash = await digest(ticket), expires = Math.min(nextUtc(now), operator?.expires_at ?? Infinity);
  // Partners skip the public bot check and IP allowance but keep public per-scan
  // query limits; their daily allowance is counted per partner email.
  const partner = operator?.role === 'partner' ? operator : null;
  const maximum = 2 * (operator && !partner ? 60 : publicMaxQueries(env)) + 2;
  await cleanPrivateMetadata(env, now);
  const lookup = () => env.DB.prepare('SELECT expires_at, max_requests FROM search_permits WHERE ticket_hash = ? AND expires_at > ?').bind(ticketHash, Date.now()).first();
  const response = async permit => {
    const count = operator ? null : await env.DB.prepare("SELECT COUNT(*) AS n FROM search_permits WHERE day = ? AND owner_hash = ? AND mode = 'public'").bind(day, owner).first();
    const remaining = partner ? await partnerRemaining(env, partner, now) : operator ? null : Math.max(0, PUBLIC_DAILY_LIMIT - count.n);
    return { search_ticket: ticket, expires_at: permit.expires_at, remaining_scans: remaining, reset_at: nextUtc(now), max_requests: permit.max_requests };
  };
  // A successfully issued permit survives a lost response and never needs a
  // second single-use challenge merely to retrieve that same opaque ticket.
  const existing = await lookup();
  if (existing) return response(existing);
  const cooldown = !operator && abuseEnabled(env);
  const publicState = () => env.DB.prepare("SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM search_permits WHERE day = ? AND owner_hash = ? AND mode = 'public'").bind(day, owner).first();
  const checkPublic = state => {
    if (state.n >= PUBLIC_DAILY_LIMIT) fail(429, 'You have used today’s three scans. Try again after midnight UTC.', { code: 'scan_limit_reached', reset_at: nextUtc(now) });
    if (cooldown && state.latest !== null && state.latest + 60000 > Date.now()) {
      const until = state.latest + 60000;
      fail(429, 'Please wait one minute between scan starts.', { code: 'scan_cooldown', reset_at: until, retry_after_seconds: Math.max(1, Math.ceil((until - Date.now()) / 1000)) });
    }
  };
  if (!operator) checkPublic(await publicState());
  try { await protectPermitStart(request, env, operator, challengeToken); }
  catch (error) { const concurrent = await lookup(); if (concurrent) return response(concurrent); throw error; }
  if (Date.now() >= expires) fail(403, 'This scan permit has expired. Start the scan again.', { code: 'search_ticket_expired', reset_at: nextUtc() });
  if (partner) await reservePartnerScan(env, partner, now);
  // One SQL statement owns both the uniqueness check and public daily cap.
  // Only HMAC-derived identifiers are stored, never the request UUID or client IP.
  // The schema's AFTER INSERT trigger increments scan_starts in this same
  // atomic statement, including when a committed response is lost and retried.
  await env.DB.prepare(`INSERT INTO search_permits
    (ticket_hash, day, owner_hash, mode, provider, created_at, expires_at, max_requests)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ? = 'operator' OR (
      (SELECT COUNT(*) FROM search_permits WHERE day = ? AND owner_hash = ? AND mode = 'public') < ?
      AND (? = 0 OR NOT EXISTS (SELECT 1 FROM search_permits WHERE day = ? AND owner_hash = ? AND mode = 'public' AND created_at > ?)))
    ON CONFLICT(ticket_hash) DO NOTHING RETURNING ticket_hash`)
    .bind(ticketHash, day, owner, mode, provider, Date.now(), expires, maximum, mode, day, owner, PUBLIC_DAILY_LIMIT, cooldown ? 1 : 0, day, owner, Date.now() - 60000).first();
  const permit = await env.DB.prepare('SELECT expires_at, max_requests FROM search_permits WHERE ticket_hash = ?').bind(ticketHash).first();
  if (!permit) { if (!operator) checkPublic(await publicState()); fail(429, 'Please wait before starting another scan.', { code: 'scan_cooldown', retry_after_seconds: 60, reset_at: Date.now() + 60000 }); }
  return response(permit);
}
export async function validateRelayPermit(request, env, operator, ticket, provider, { requireCapacity = true } = {}) {
  const now = Date.now(), day = utcDay(now), mode = operator ? 'operator' : 'public';
  if (typeof ticket !== 'string' || !/^[a-f0-9]{64}$/.test(ticket)) fail(403, 'Start a scan before searching.', { code: 'search_ticket_required' });
  const owner = operator ? operator.token_hash : await dailyIpHash(request, env, now), ticketHash = await digest(ticket);
  const permit = await env.DB.prepare('SELECT day, owner_hash, mode, provider, expires_at, requests, max_requests FROM search_permits WHERE ticket_hash = ?').bind(ticketHash).first();
  if (!permit || permit.mode !== mode || permit.provider !== provider || permit.owner_hash !== owner) fail(403, 'This scan permit is no longer valid. Start the scan again.', { code: 'search_ticket_invalid' });
  if (permit.expires_at <= now || permit.day !== day) fail(403, 'This scan permit has expired. Start the scan again.', { code: 'search_ticket_expired', reset_at: nextUtc(now) });
  if (requireCapacity && permit.requests >= permit.max_requests) fail(429, 'This scan has reached its request limit. Start a new scan to continue.', { code: 'search_ticket_exhausted', reset_at: nextUtc(now) });
  return { now, day, mode, ticketHash };
}
export async function reserveRelay(request, env, operator, ticket, provider, options) {
  // Only server code chooses this accounting override. Validate it before the
  // permit is consumed; the permit remains bound to the primary search service.
  const { usageProvider, costPer1000, dailyProviderLimit } = accountingOptions(provider, options);
  const { now, day, mode, ticketHash } = await validateRelayPermit(request, env, operator, ticket, provider);
  const reservedPermit = await env.DB.prepare('UPDATE search_permits SET requests = requests + 1 WHERE ticket_hash = ? AND requests < max_requests AND expires_at > ? RETURNING requests').bind(ticketHash, now).first();
  if (!reservedPermit) fail(429, 'This scan has reached its request limit. Start a new scan to continue.', { code: 'search_ticket_exhausted', reset_at: nextUtc(now) });
  const cost = costPer1000 === undefined ? searchCost(env) : costPer1000 / 1000;
  const countLimit = Number(env.DAILY_SERP_LIMIT ?? 3000), spendLimit = Number(env.DAILY_USD_LIMIT ?? 15);
  if (!operator && ![countLimit, spendLimit].every(n => Number.isFinite(n) && n >= 0)) fail(503, 'Search limits are unavailable.');
  await usageRow(env, day, mode, usageProvider);
  // Public caps still include all public providers. An explicitly configured
  // provider cap also covers operators, atomically across both modes.
  const usage = await env.DB.prepare(`UPDATE private_usage_summary
    SET search_attempts = search_attempts + 1, estimated_search_cost_usd = ROUND(estimated_search_cost_usd + ?, 12)
    WHERE day = ? AND mode = ? AND provider = ?
    AND (? IS NULL OR (SELECT COALESCE(SUM(search_attempts), 0) FROM private_usage_summary WHERE day = ? AND provider = ?) + 1 <= ?)
    AND (? = 'operator' OR (
      (SELECT COALESCE(SUM(search_attempts), 0) FROM private_usage_summary WHERE day = ? AND mode = 'public') + 1 <= ? AND
      ROUND((SELECT COALESCE(SUM(estimated_search_cost_usd), 0) FROM private_usage_summary WHERE day = ? AND mode = 'public') + ?, 12) <= ?)) RETURNING day`)
    .bind(cost, day, mode, usageProvider, dailyProviderLimit, day, usageProvider, dailyProviderLimit,
      mode, day, operator ? 0 : countLimit, day, cost, operator ? 0 : spendLimit).first();
  if (!usage) fail(429, 'The daily search limit has been reached. Please try again tomorrow.', { code: 'daily_search_limit', reset_at: nextUtc(now) });
  return { day, mode, provider: usageProvider };
}
export async function finishRelay(env, reservation, success) {
  const column = success ? 'search_successes' : 'search_failures';
  await env.DB.prepare(`UPDATE private_usage_summary SET ${column} = ${column} + 1 WHERE day = ? AND mode = ? AND provider = ?`)
    .bind(reservation.day, reservation.mode, reservation.provider).run();
}
const emptyTotals = () => ({ scan_starts: 0, search_attempts: 0, search_successes: 0, search_failures: 0, estimated_search_cost_usd: 0, in_tokens: 0, out_tokens: 0, tokens: 0, ai_cost_usd: 0 });
export async function usageDashboard(env, provider) {
  const now = Date.now();
  await cleanPrivateMetadata(env, now);
  const { results = [] } = await env.DB.prepare('SELECT day, mode, provider, scan_starts, search_attempts, search_successes, search_failures, estimated_search_cost_usd FROM private_usage_summary WHERE day >= ? ORDER BY day DESC').bind(utcDay(now - 29 * 86400000)).all();
  const days = Array.from({ length: 30 }, (_, index) => ({ date: utcDay(now - index * 86400000), public: emptyTotals(), operator: emptyTotals() }));
  const byDay = new Map(days.map(day => [day.date, day]));
  for (const row of results) {
    const total = byDay.get(row.day)?.[row.mode];
    if (!total) continue;
    for (const key of ['scan_starts', 'search_attempts', 'search_successes', 'search_failures', 'estimated_search_cost_usd']) total[key] += Number(row[key]) || 0;
    total.estimated_search_cost_usd = Math.round(total.estimated_search_cost_usd * 1e12) / 1e12;
  }
  const providers = [{ provider, cost_per_1000_queries: searchCost(env) * 1000, estimated: true }];
  if (env.GOOGLE_BACKUP_PROVIDER && env.GOOGLE_BACKUP_PROVIDER !== provider) {
    const backup = accountingOptions(provider, { usageProvider: env.GOOGLE_BACKUP_PROVIDER,
      costPer1000: Number(env.GOOGLE_BACKUP_COST_PER_1K ?? 0), dailyProviderLimit: Number(env.GOOGLE_BACKUP_DAILY_LIMIT ?? 50) });
    providers.push({ provider: backup.usageProvider, cost_per_1000_queries: backup.costPer1000, estimated: true, role: 'backup',
      daily_query_limit: backup.dailyProviderLimit, estimate_supplied: backup.costPer1000 > 0,
      estimate_notice: backup.costPer1000 > 0 ? 'Configured estimate; actual provider billing may differ.'
        : 'No cost estimate supplied. A zero estimate does not establish that the backup provider is free.' });
  }
  return { today: days[0], days, providers,
    cloud_ai_enabled: false, public_daily_limit: PUBLIC_DAILY_LIMIT, operator_daily_limit: null, retention_days: 30 };
}
