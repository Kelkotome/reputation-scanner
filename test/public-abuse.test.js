import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/private-worker.js';
import { dailyIpHash, digest } from '../src/operator-access.js';
import { verifyChallenge } from '../src/public-abuse.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const verifyUrl = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const origin = 'https://scanner.example', address = '203.0.113.7';
const accessKey = 'synthetic-operator-access-key-32-chars';
const assistance = { consent: true, name: 'Example Reporter', email: 'reporter@example.test', message: 'Please help', help_type: 'unsure' };
let sqlite, env, statements;
function prepare(sql, args = []) {
  const log = () => statements.push({ sql, args });
  return { bind: (...values) => prepare(sql, values),
    first: async () => { await Promise.resolve(); log(); return sqlite.prepare(sql).get(...args) || null; },
    run: async () => { await Promise.resolve(); log(); return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
    all: async () => { log(); return { results: sqlite.prepare(sql).all(...args) }; },
  };
}
async function api(path, method = 'GET', body, headers = {}, host = origin) {
  const response = await worker.fetch(new Request(`${host}${path}`, { method,
    headers: { 'CF-Connecting-IP': address, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: response.status, data: await response.json(), headers: response.headers };
}
const permit = (request_id = crypto.randomUUID(), challenge_token = 'scan-token', headers = {}, host) => api('/api/search-session', 'POST', { request_id, ...(challenge_token === undefined ? {} : { challenge_token }) }, headers, host);
const relay = (ticket, headers = {}) => api('/api/search', 'POST', { q: 'Example Person complaint', kind: 'search', country_code: '', search_ticket: ticket }, headers);
const verifyResponse = (action = 'scan_start', patch = {}) => Response.json({ success: true, hostname: 'scanner.example', action, ...patch });
const providerResponse = () => Response.json({ organic_results: [{ title: 'Result', link: 'https://publisher.example/story', snippet: 'Metadata' }] });
function mockNormalFetch() {
  fetch.mockImplementation(async (url, options) => String(url) === verifyUrl
    ? verifyResponse(JSON.parse(options.body).response.startsWith('assist') ? 'assistance' : 'scan_start') : providerResponse());
}
async function login() {
  const result = await api('/api/operator/login', 'POST', { access_key: accessKey });
  expect(result.status).toBe(200);
  return { Cookie: result.headers.get('set-cookie').split(';')[0] };
}
function seedBusy(count = 6, owner = 'other-owner') {
  for (let i = 0; i < count; i++) sqlite.prepare('INSERT INTO relay_leases VALUES (?, ?, ?)').run(crypto.randomUUID(), owner, Date.now() + 30000);
}
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:'); sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')); statements = [];
  env = { DB: { prepare }, SERP_PROVIDER: 'serpapi', SERP_API_KEY: 'synthetic-provider-key', ALLOW_SEARCH_RELAY: 'true',
    RATE_LIMIT_SECRET: 'synthetic-rate-limit-secret-32-chars', OPERATOR_ACCESS_KEY: accessKey, ABUSE_PROTECTION_ENABLED: 'true',
    TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: 'synthetic-public-site-key', TURNSTILE_SECRET_KEY: 'synthetic-private-site-key', TURNSTILE_HOSTNAME: 'scanner.example' };
  vi.stubGlobal('fetch', vi.fn()); mockNormalFetch();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); sqlite.close(); });

describe('public challenge boundary', () => {
  it('exposes only the site key and explicit fail-closed configuration state', async () => {
    expect((await api('/api/config')).data).toMatchObject({ abuse_protection_enabled: true, bot_check_required: true, bot_check_configured: true, turnstile_site_key: env.TURNSTILE_SITE_KEY, scan_cooldown_seconds: 60 });
    delete env.TURNSTILE_SECRET_KEY;
    const config = (await api('/api/config')).data;
    expect(config).toMatchObject({ bot_check_required: true, bot_check_configured: false, turnstile_site_key: null });
    expect(JSON.stringify(config)).not.toContain('synthetic-private-site-key');
    expect((await permit()).data.code).toBe('bot_check_unavailable');
    expect(fetch).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(0);
  });
  it.each([{ TURNSTILE_ENABLED: 'false' }, { TURNSTILE_SITE_KEY: '' }, { TURNSTILE_SECRET_KEY: '' }, { TURNSTILE_HOSTNAME: 'other.example' }])('does not bypass hosted verification for %j', async patch => {
    Object.assign(env, patch, { LOCAL_DEVELOPMENT: 'true' });
    expect((await permit()).status).toBe(503); expect(fetch).not.toHaveBeenCalled();
  });
  it('permits an explicit loopback-only development bypass while retaining quotas', async () => {
    env.LOCAL_DEVELOPMENT = 'true'; env.TURNSTILE_ENABLED = 'false';
    const response = await permit(crypto.randomUUID(), undefined, { 'CF-Connecting-IP': 'forged' }, 'http://localhost:8787');
    expect(response.status).toBe(200); expect(fetch).not.toHaveBeenCalled();
    expect((await api('/api/config', 'GET', undefined, {}, 'http://localhost:8787')).data).toMatchObject({ bot_check_required: false, bot_check_configured: true });
    expect((await permit(crypto.randomUUID(), undefined, {}, 'http://localhost:8787')).data.code).toBe('scan_cooldown');
  });
  it('requires the challenge and sends Siteverify only its secret and opaque token', async () => {
    const missing = await api('/api/search-session', 'POST', { request_id: crypto.randomUUID() });
    expect(missing.data.code).toBe('bot_check_required'); expect(fetch).not.toHaveBeenCalled();
    const response = await permit(); expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe(verifyUrl);
    expect(options).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store' });
    expect(JSON.parse(options.body)).toEqual({ secret: 'synthetic-private-site-key', response: 'scan-token' });
    expect(JSON.stringify(statements)).not.toMatch(/203\.0\.113\.7|scan-token|synthetic-private-site-key|Example Person/);
  });
  it.each([{ success: false, 'error-codes': ['private-provider-message'] }, { success: 'true' }, { hostname: 'other.example' }, { action: 'assistance' }])('rejects failed or mismatched verification without issuing a permit: %j', async patch => {
    fetch.mockResolvedValueOnce(verifyResponse('scan_start', patch));
    const response = await permit();
    expect(response.status).toBe(403); expect(response.data.code).toBe('bot_check_failed');
    expect(JSON.stringify(response.data)).not.toContain('private-provider-message');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM private_usage_summary').get().n).toBe(0);
  });
  it('reissues an existing valid permit without another single-use challenge or cooldown charge', async () => {
    const id = crypto.randomUUID(), first = await permit(id);
    const retry = await api('/api/search-session', 'POST', { request_id: id });
    expect(retry.status).toBe(200); expect(retry.data.search_ticket).toBe(first.data.search_ticket);
    expect(fetch).toHaveBeenCalledOnce();
    expect(sqlite.prepare('SELECT scan_starts FROM private_usage_summary').get().scan_starts).toBe(1);
    expect((await permit()).data.code).toBe('scan_cooldown');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('enforces cooldown atomically for concurrent valid starts', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => permit()));
    expect(responses.filter(item => item.status === 200)).toHaveLength(1);
    expect(responses.filter(item => item.data.code === 'scan_cooldown')).toHaveLength(5);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(1);
  });
  it('does not accept a replayed challenge for another scan after cooldown', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    await permit(); vi.advanceTimersByTime(61000);
    fetch.mockResolvedValueOnce(verifyResponse('scan_start', { success: false, 'error-codes': ['timeout-or-duplicate'] }));
    expect((await permit()).data.code).toBe('bot_check_failed');
    expect(sqlite.prepare('SELECT scan_starts FROM private_usage_summary').get().scan_starts).toBe(1);
  });
  it('throttles repeated failed challenges before more external validation', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    fetch.mockImplementation(async () => verifyResponse('scan_start', { success: false }));
    const responses = await Promise.all(Array.from({ length: 15 }, () => permit()));
    expect(responses.filter(item => item.data.code === 'request_rate_limited')).toHaveLength(5);
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(0);
  });
  it('preflights provider capacity before verification or scan charge while allowing idempotent recovery', async () => {
    const id = crypto.randomUUID(), first = await permit(id); fetch.mockClear(); seedBusy();
    expect((await permit(crypto.randomUUID(), 'scan-token', { 'CF-Connecting-IP': '203.0.113.8' })).data.code).toBe('search_busy');
    const retry = await api('/api/search-session', 'POST', { request_id: id });
    expect(retry.data.search_ticket).toBe(first.data.search_ticket); expect(fetch).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT scan_starts FROM private_usage_summary').get().scan_starts).toBe(1);
  });
});

describe('bounded verification transport', () => {
  const request = () => new Request(origin);
  it('rejects redirects and malformed or oversized bodies without exposing raw errors', async () => {
    for (const response of [new Response('private redirect body', { status: 302, headers: { Location: 'https://untrusted.example/?secret=private' } }),
      new Response('private invalid JSON', { headers: { 'Content-Type': 'application/json' } }),
      new Response('private body', { headers: { 'Content-Type': 'application/json', 'Content-Length': '16385' } })]) {
      const stub = vi.fn(async () => response);
      await expect(verifyChallenge(request(), env, null, 'opaque-token', 'scan_start', stub)).rejects.toMatchObject({ status: 503, details: { code: 'bot_check_unavailable' } });
      expect(stub).toHaveBeenCalledOnce();
    }
  });
  it('cancels an oversized streamed response even without Content-Length', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16385)); }, cancel });
    await expect(verifyChallenge(request(), env, null, 'opaque-token', 'scan_start', async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }))).rejects.toMatchObject({ status: 503 });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('aborts verification after five seconds without leaking transport details', async () => {
    vi.useFakeTimers(); let signal;
    const stub = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal; signal.addEventListener('abort', () => reject(new Error('private transport error')), { once: true });
    }));
    const waiting = expect(verifyChallenge(request(), env, null, 'opaque-token', 'scan_start', stub)).rejects.toMatchObject({ status: 503, details: { code: 'bot_check_unavailable' } });
    await vi.advanceTimersByTimeAsync(5000); await waiting; expect(signal.aborted).toBe(true);
  });
});

describe('assistance abuse controls', () => {
  it('verifies the assistance action, caps direct API submissions at three/hour, and keeps shared content out of Siteverify', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    for (let i = 0; i < 3; i++) expect((await api('/api/assistance', 'POST', { ...assistance, challenge_token: `assist-${i}` })).status).toBe(201);
    expect((await api('/api/assistance', 'POST', { ...assistance, challenge_token: 'assist-extra' })).data.code).toBe('assistance_limit');
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [, options] of fetch.mock.calls) expect(Object.keys(JSON.parse(options.body)).sort()).toEqual(['response', 'secret']);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM assistance_requests').get().n).toBe(3);
  });
  it('failed verification saves no assistance and consumes no hourly submission slot', async () => {
    fetch.mockResolvedValueOnce(verifyResponse('scan_start'));
    const response = await api('/api/assistance', 'POST', { ...assistance, challenge_token: 'wrong-action' });
    expect(response.data.code).toBe('bot_check_failed');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM assistance_requests').get().n).toBe(0);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM public_abuse_counters WHERE scope='assistance_hour'").get().n).toBe(0);
  });
  it('does not contact verification before explicit consent and field validation', async () => {
    expect((await api('/api/assistance', 'POST', { ...assistance, consent: false, challenge_token: 'assist-token' })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled(); expect(statements).toHaveLength(0);
  });
});

describe('atomic relay concurrency leases', () => {
  it('never occupies provider slots while an unverified ticket lookup is pending', async () => {
    const invalid = '0'.repeat(64), hash = await digest(invalid);
    let unblock, waiting = false;
    const gate = new Promise(resolve => { unblock = resolve; });
    env.DB.prepare = sql => {
      const statement = prepare(sql);
      return { ...statement, bind: (...args) => {
        const bound = statement.bind(...args);
        return { ...bound, first: async () => {
          if (sql.startsWith('SELECT day, owner_hash') && args[0] === hash) { waiting = true; await gate; }
          return bound.first();
        } };
      } };
    };
    const pending = relay(invalid);
    await vi.waitFor(() => expect(waiting).toBe(true));
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM relay_leases').get().n).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    unblock(); expect((await pending).data.code).toBe('search_ticket_invalid');
  });
  it('limits public owners to two simultaneous relays and does not charge busy retries', async () => {
    const { data } = await permit(); fetch.mockClear();
    const release = []; fetch.mockImplementation(() => new Promise(resolve => release.push(() => resolve(providerResponse()))));
    const pending = Array.from({ length: 5 }, () => relay(data.search_ticket));
    await vi.waitFor(() => expect(release).toHaveLength(2));
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM relay_leases').get().n).toBe(2);
    release.forEach(resolve => resolve());
    const results = await Promise.all(pending);
    expect(results.filter(result => result.status === 200)).toHaveLength(2);
    expect(results.filter(result => result.data.code === 'search_busy')).toHaveLength(3);
    expect(sqlite.prepare('SELECT requests FROM search_permits').get().requests).toBe(2);
    expect(sqlite.prepare('SELECT search_attempts FROM private_usage_summary').get().search_attempts).toBe(2);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM relay_leases').get().n).toBe(0);
  });
  it('operators skip public challenges but retain four simultaneous relays', async () => {
    const headers = await login();
    const { data } = await permit(crypto.randomUUID(), undefined, headers);
    expect(fetch).not.toHaveBeenCalled();
    expect((await api('/api/config', 'GET', undefined, headers)).data.bot_check_required).toBe(false);
    const release = []; fetch.mockImplementation(() => new Promise(resolve => release.push(() => resolve(providerResponse()))));
    const pending = Array.from({ length: 6 }, () => relay(data.search_ticket, headers));
    await vi.waitFor(() => expect(release).toHaveLength(4)); release.forEach(resolve => resolve());
    const results = await Promise.all(pending);
    expect(results.filter(result => result.status === 200)).toHaveLength(4);
    expect(results.filter(result => result.data.code === 'search_busy')).toHaveLength(2);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM relay_leases').get().n).toBe(0);
  });
  it('limits operator permit bursts to thirty per minute without adding a daily cap or challenging staff', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    const headers = await login(), id = crypto.randomUUID();
    const first = await permit(id, undefined, headers);
    const pending = Array.from({ length: 34 }, () => permit(crypto.randomUUID(), undefined, headers));
    const results = await Promise.all(pending);
    expect(results.filter(result => result.status === 200)).toHaveLength(29);
    expect(results.filter(result => result.data.code === 'request_rate_limited')).toHaveLength(5);
    expect((await permit(id, undefined, headers)).data.search_ticket).toBe(first.data.search_ticket);
    vi.advanceTimersByTime(61000);
    expect((await permit(crypto.randomUUID(), undefined, headers)).status).toBe(200);
    expect(sqlite.prepare('SELECT scan_starts FROM private_usage_summary').get().scan_starts).toBe(31);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('caps global concurrent relays at six across different owners', async () => {
    const permits = [];
    for (let i = 0; i < 4; i++) {
      const headers = { 'CF-Connecting-IP': `203.0.113.${20 + i}` };
      permits.push({ headers, ticket: (await permit(crypto.randomUUID(), `scan-${i}`, headers)).data.search_ticket });
    }
    const release = []; fetch.mockImplementation(() => new Promise(resolve => release.push(() => resolve(providerResponse()))));
    const pending = permits.flatMap(({ headers, ticket }) => [relay(ticket, headers), relay(ticket, headers)]);
    await vi.waitFor(() => expect(release).toHaveLength(6)); release.forEach(resolve => resolve());
    const results = await Promise.all(pending);
    expect(results.filter(result => result.status === 200)).toHaveLength(6);
    expect(results.filter(result => result.data.code === 'search_busy')).toHaveLength(2);
  });
  it('releases leases on provider failure, reservation rejection and invalid tickets; expired leases recover capacity', async () => {
    const { data } = await permit();
    fetch.mockResolvedValueOnce(new Response('private provider failure', { status: 503 }));
    expect((await relay(data.search_ticket)).status).toBe(502);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM relay_leases').get().n).toBe(0);
    env.DAILY_SERP_LIMIT = 0;
    expect((await relay(data.search_ticket)).status).toBe(429);
    expect((await relay('a'.repeat(64))).status).toBe(403);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM relay_leases').get().n).toBe(0);
    seedBusy(); sqlite.prepare('UPDATE relay_leases SET expires_at = ?').run(Date.now() - 1); env.DAILY_SERP_LIMIT = 3000;
    expect((await relay(data.search_ticket)).status).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM relay_leases').get().n).toBe(0);
  });
  it('cleans short-lived counters and leases without saving raw IP or query data', async () => {
    const owner = await dailyIpHash(new Request(origin, { headers: { 'CF-Connecting-IP': address } }), env);
    sqlite.prepare('INSERT INTO public_abuse_counters VALUES (?, ?, ?, ?, ?)').run(owner, 'relay', 1, 3, Date.now() - 1);
    sqlite.prepare('INSERT INTO relay_leases VALUES (?, ?, ?)').run('expired', owner, Date.now() - 1);
    await worker.scheduled({}, env);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM public_abuse_counters').get().n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM relay_leases').get().n).toBe(0);
    expect(JSON.stringify(statements)).not.toMatch(/203\.0\.113\.7|Example Person/);
  });
});
