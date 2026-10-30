import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/private-worker.js';
import { dailyIpHash, nextUtc, utcDay, expandV6, ipv6Bucket } from '../src/operator-access.js';
import { startSearchSession, reserveRelay, finishRelay, usageDashboard } from '../src/quota-usage.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
let sqlite, env, statements;
const address = '203.0.113.7';
const accessKey = 'synthetic-operator-access-key-32-chars-only';
const rateSecret = 'synthetic-rate-limit-secret-32-chars-only';
const query = { q: 'Example Person complaint', country_code: '', kind: 'search' };
function prepare(sql, args = []) {
  const log = () => statements.push({ sql, args });
  return { bind: (...values) => prepare(sql, values),
    first: async () => { await Promise.resolve(); log(); return sqlite.prepare(sql).get(...args) || null; },
    run: async () => { await Promise.resolve(); log(); return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; },
    all: async () => { await Promise.resolve(); log(); return { results: sqlite.prepare(sql).all(...args) }; },
  };
}
async function api(path, method = 'GET', body, headers = {}, origin = 'https://scanner.example') {
  const response = await worker.fetch(new Request(`${origin}${path}`, { method,
    headers: { 'CF-Connecting-IP': address, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  return { status: response.status, data: await response.json(), headers: response.headers };
}
async function login(headers = {}, origin) {
  const response = await api('/api/operator/login', 'POST', { access_key: accessKey }, headers, origin);
  expect(response.status).toBe(200);
  return { response, cookie: response.headers.get('set-cookie').split(';')[0] };
}
const permit = (headers = {}, request_id = crypto.randomUUID(), origin) => api('/api/search-session', 'POST', { request_id }, headers, origin);
const relay = (ticket, headers = {}) => api('/api/search', 'POST', { ...query, search_ticket: ticket }, headers);
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  statements = [];
  env = { DB: { prepare }, SERP_PROVIDER: 'serpapi', SERP_API_KEY: 'synthetic-provider-key', ALLOW_SEARCH_RELAY: 'true',
    OPERATOR_ACCESS_KEY: accessKey, RATE_LIMIT_SECRET: rateSecret, MAX_QUERIES: '12',
    ASSETS: { fetch: vi.fn() } };
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ organic_results: [{ title: 'Example result', link: 'https://publisher.example/story', snippet: 'Example snippet' }] })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); sqlite.close(); });

describe('operator authentication', () => {
  it('issues a hashed revocable eight-hour HttpOnly session and never returns credentials in JSON', async () => {
    const { response, cookie } = await login();
    const header = response.headers.get('set-cookie');
    expect(header).toContain('__Host-ns_operator='); expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Strict'); expect(header).toContain('Secure'); expect(header).toContain('Max-Age=28800');
    expect(response.data).toEqual({ ok: true, operator: true, expires_at: expect.any(Number) });
    const stored = sqlite.prepare('SELECT * FROM operator_sessions').get();
    expect(stored.expires_at - stored.created_at).toBe(8 * 3600000);
    expect(stored.token_hash).not.toBe(cookie.split('=')[1]);
    expect(JSON.stringify(statements)).not.toMatch(new RegExp(`${address}|${accessKey}|${rateSecret}|${cookie.split('=')[1]}`));
    expect((await api('/api/operator/session', 'GET', undefined, { Cookie: cookie })).data.operator).toBe(true);
    expect((await api('/api/config', 'GET', undefined, { Cookie: cookie })).data).toMatchObject({ operator: true, max_queries: 60, scan_ticket_required: true });
    const logout = await api('/api/operator/logout', 'POST', {}, { Cookie: cookie });
    expect(logout.data.operator).toBe(false); expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await api('/api/operator/session', 'GET', undefined, { Cookie: cookie })).data).toEqual({ operator: false });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM operator_sessions').get().n).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('invalidates sessions on key rotation, expiry and forged or duplicate cookies', async () => {
    const { cookie } = await login();
    env.OPERATOR_ACCESS_KEY = 'new-operator-access-key-after-rotation-123';
    expect((await api('/api/operator/session', 'GET', undefined, { Cookie: cookie })).data.operator).toBe(false);
    env.OPERATOR_ACCESS_KEY = accessKey;
    expect((await api('/api/operator/session', 'GET', undefined, { Cookie: `${cookie}; ${cookie}` })).data.operator).toBe(false);
    expect((await api('/api/operator/usage', 'GET', undefined, { Cookie: `__Host-ns_operator=${'0'.repeat(64)}` })).status).toBe(401);
    sqlite.prepare('UPDATE operator_sessions SET expires_at = ?').run(Date.now() - 1);
    expect((await api('/api/operator/session', 'GET', undefined, { Cookie: cookie })).data.operator).toBe(false);
  });
  it('atomically rate-limits sign-in attempts using only daily IP hashes', async () => {
    const results = await Promise.all(Array.from({ length: 15 }, () => api('/api/operator/login', 'POST', { access_key: 'incorrect' })));
    expect(results.filter(item => item.status === 401)).toHaveLength(10);
    expect(results.filter(item => item.status === 429)).toHaveLength(5);
    expect(sqlite.prepare('SELECT attempts FROM operator_login_limits').get().attempts).toBe(10);
    expect(JSON.stringify(statements)).not.toContain(address);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM operator_sessions').get().n).toBe(0);
  });
  it.each([{ OPERATOR_ACCESS_KEY: undefined }, { OPERATOR_ACCESS_KEY: 'weak' }, { RATE_LIMIT_SECRET: undefined }, { RATE_LIMIT_SECRET: 'weak' }])('fails closed for missing/weak server configuration %j', async patch => {
    Object.assign(env, patch);
    expect((await api('/api/operator/login', 'POST', { access_key: accessKey })).status).toBe(503);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM operator_sessions').get().n).toBe(0);
  });
  it('requires same-origin JSON, rejects URL credentials, and allows insecure cookies only for explicit local development', async () => {
    expect((await api('/api/operator/login', 'POST', { access_key: accessKey }, { Origin: 'https://other.example' })).status).toBe(403);
    expect((await api('/api/operator/login', 'POST', { access_key: accessKey }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await api(`/api/operator/login?access_key=${accessKey}`, 'POST', { access_key: accessKey })).status).toBe(400);
    expect((await api('/api/operator/login', 'POST', { access_key: accessKey }, {}, 'http://localhost:8787')).status).toBe(403);
    env.LOCAL_DEVELOPMENT = 'true';
    const { response } = await login({ 'CF-Connecting-IP': 'spoofed-value' }, 'http://localhost:8787');
    expect(response.headers.get('set-cookie')).toContain('ns_operator_dev=');
    expect(response.headers.get('set-cookie')).not.toContain('Secure');
    expect((await api('/api/operator/login', 'POST', { access_key: accessKey }, {}, 'http://scanner.example')).status).toBe(403);
  });
});

describe('public and operator scan permits', () => {
  it('does not issue or charge permits when sharing is disabled or the provider is unconfigured', async () => {
    env.ALLOW_SEARCH_RELAY = 'false';
    expect((await permit()).status).toBe(403);
    env.ALLOW_SEARCH_RELAY = 'true'; delete env.SERP_API_KEY;
    expect((await permit()).status).toBe(503);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('allows exactly three concurrent public starts, idempotently reissues a full-quota permit, and stores neither UUID nor IP', async () => {
    const ids = Array.from({ length: 8 }, () => crypto.randomUUID());
    const results = await Promise.all(ids.map(id => permit({}, id)));
    expect(results.filter(result => result.status === 200)).toHaveLength(3);
    expect(results.filter(result => result.status === 429)).toHaveLength(5);
    const firstIndex = results.findIndex(result => result.status === 200), first = results[firstIndex];
    expect(first.data).toMatchObject({ search_ticket: expect.stringMatching(/^[a-f0-9]{64}$/), expires_at: nextUtc(), max_requests: 26 });
    expect((await permit({}, ids[firstIndex])).data.search_ticket).toBe(first.data.search_ticket);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(3);
    expect(sqlite.prepare('SELECT scan_starts FROM private_usage_summary').get().scan_starts).toBe(3);
    const persisted = JSON.stringify(statements);
    for (const value of [...ids, address, first.data.search_ticket]) expect(persisted).not.toContain(value);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('supports twenty-four configured public queries with bounded retries and the unchanged daily scan allowance', async () => {
    env.MAX_QUERIES = '24';
    expect((await api('/api/config')).data).toMatchObject({ operator: false, max_queries: 24, public_daily_limit: 3 });
    const first = await permit();
    expect(first.status).toBe(200);
    expect(first.data).toMatchObject({ max_requests: 50, remaining_scans: 2 });
    const results = await Promise.all(Array.from({ length: 52 }, () => relay(first.data.search_ticket)));
    expect(results.filter(result => result.status === 200)).toHaveLength(50);
    expect(results.filter(result => result.status === 429 && result.data.code === 'search_ticket_exhausted')).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(50);
    expect(sqlite.prepare('SELECT requests, max_requests FROM search_permits').get()).toEqual({ requests: 50, max_requests: 50 });
    expect(sqlite.prepare('SELECT scan_starts, search_attempts, search_successes FROM private_usage_summary').get()).toEqual({ scan_starts: 1, search_attempts: 50, search_successes: 50 });
    expect((await permit()).status).toBe(200);
    expect((await permit()).status).toBe(200);
    expect((await permit()).data.code).toBe('scan_limit_reached');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(3);
    expect(JSON.stringify(statements)).not.toMatch(/Example Person|publisher\.example|synthetic-provider-key/);
  });
  it('concurrent retries of one independent UUID create one permit and one scan start', async () => {
    const id = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => permit({}, id)));
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(new Set(results.map(result => result.data.search_ticket)).size).toBe(1);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(1);
    expect(sqlite.prepare('SELECT scan_starts FROM private_usage_summary').get().scan_starts).toBe(1);
  });
  it('rolls back the permit when its atomic scan-start write fails, then safely retries', async () => {
    const id = crypto.randomUUID();
    sqlite.exec(`CREATE TRIGGER fail_summary_write BEFORE INSERT ON private_usage_summary
      BEGIN SELECT RAISE(ABORT, 'synthetic summary failure'); END;`);
    expect((await permit({}, id)).status).toBe(500);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM private_usage_summary').get().n).toBe(0);
    sqlite.exec('DROP TRIGGER fail_summary_write');
    expect((await permit({}, id)).status).toBe(200);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(1);
    expect(sqlite.prepare('SELECT scan_starts FROM private_usage_summary').get().scan_starts).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves exactly one scan start when the committed permit response is lost and retried', async () => {
    const id = crypto.randomUUID();
    let loseResponse = true;
    const wrap = statement => ({ ...statement,
      bind: (...args) => wrap(statement.bind(...args)),
      first: async () => {
        const result = await statement.first();
        if (loseResponse) { loseResponse = false; throw new Error('synthetic lost database response'); }
        return result;
      },
    });
    env.DB.prepare = sql => sql.startsWith('INSERT INTO search_permits') ? wrap(prepare(sql)) : prepare(sql);
    expect((await permit({}, id)).status).toBe(500);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(1);
    expect(sqlite.prepare('SELECT scan_starts FROM private_usage_summary').get().scan_starts).toBe(1);
    const recovered = await permit({}, id);
    expect(recovered.status).toBe(200);
    expect((await permit({}, id)).data.search_ticket).toBe(recovered.data.search_ticket);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(1);
    expect(sqlite.prepare('SELECT scan_starts FROM private_usage_summary').get().scan_starts).toBe(1);
  });
  it('requires valid permits and rejects cross-IP, changed-provider, tampered and expired tickets before outbound requests', async () => {
    const { data } = await permit();
    expect((await api('/api/search', 'POST', query)).data.code).toBe('search_ticket_required');
    expect((await relay('0'.repeat(64))).data.code).toBe('search_ticket_invalid');
    expect((await relay(data.search_ticket, { 'CF-Connecting-IP': '203.0.113.8' })).data.code).toBe('search_ticket_invalid');
    env.SERP_PROVIDER = 'serper';
    expect((await relay(data.search_ticket)).data.code).toBe('search_ticket_invalid');
    env.SERP_PROVIDER = 'serpapi';
    sqlite.prepare('UPDATE search_permits SET expires_at = ?').run(Date.now() - 1);
    expect((await relay(data.search_ticket)).data.code).toBe('search_ticket_expired');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds concurrent requests per permit and keeps failures charged with no content stored', async () => {
    env.MAX_QUERIES = 1;
    const { data } = await permit();
    fetch.mockResolvedValue(new Response('private query and synthetic-provider-key', { status: 503 }));
    const results = await Promise.all(Array.from({ length: 8 }, () => relay(data.search_ticket)));
    expect(results.filter(result => result.status === 502)).toHaveLength(4);
    expect(results.filter(result => result.status === 429)).toHaveLength(4);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(sqlite.prepare('SELECT * FROM private_usage_summary').get()).toMatchObject({ scan_starts: 1, search_attempts: 4, search_successes: 0, search_failures: 4, estimated_search_cost_usd: 0.004 });
    expect(JSON.stringify(statements)).not.toMatch(/Example Person|publisher\.example|synthetic-provider-key|private query/);
  });
  it('operator permits allow unlimited starts and bypass public budgets while retaining per-permit limits and revocation', async () => {
    const { cookie } = await login(), headers = { Cookie: cookie };
    env.DAILY_SERP_LIMIT = 0; env.DAILY_USD_LIMIT = 0;
    const results = await Promise.all(Array.from({ length: 8 }, () => permit(headers)));
    expect(results.every(result => result.status === 200 && result.data.remaining_scans === null && result.data.max_requests === 122)).toBe(true);
    expect((await relay(results[0].data.search_ticket, headers)).status).toBe(200);
    const publicPermit = await permit();
    expect((await relay(publicPermit.data.search_ticket)).status).toBe(429);
    expect(fetch).toHaveBeenCalledOnce();
    sqlite.prepare("UPDATE search_permits SET requests = max_requests WHERE mode = 'operator'").run();
    expect((await relay(results[0].data.search_ticket, headers)).data.code).toBe('search_ticket_exhausted');
    await api('/api/operator/logout', 'POST', {}, headers);
    expect((await relay(results[0].data.search_ticket, headers)).status).toBe(403);
  });
  it.each(['', '203.0.113.7, 203.0.113.8', 'not-an-ip', '999.1.1.1', '01.2.3.4', 'fe80::1%en0'])('rejects missing or noncanonical client addresses: %s', async ip => {
    expect((await permit({ 'CF-Connecting-IP': ip, 'X-Forwarded-For': address })).status).toBe(403);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(0);
  });
  it('canonicalizes IPv6, rotates daily hashes and ignores spoofed forwarded headers only in explicit local development', async () => {
    const request = ip => new Request('https://scanner.example/', { headers: { 'CF-Connecting-IP': ip } });
    const hash = await dailyIpHash(request('2001:db8::1'), env);
    expect(await dailyIpHash(request('2001:0db8:0:0:0:0:0:1'), env)).toBe(hash);
    expect(await dailyIpHash(request('2001:db8::1'), env, Date.now() + 86400000)).not.toBe(hash);
    env.LOCAL_DEVELOPMENT = 'true';
    const local = ip => new Request('http://127.0.0.1:8787/', { headers: { 'CF-Connecting-IP': ip } });
    expect(await dailyIpHash(local('forged'), env)).toBe(await dailyIpHash(local('different'), env));
  });
  it('expands compressed IPv6 literals and rejects malformed ones', () => {
    expect(expandV6('[2001:db8::1]')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(expandV6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(expandV6('fe80::')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 0]);
    expect(expandV6('1:2:3:4:5:6:7:8')).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const bad of ['1::2::3', '1:2:3', '1:2:3:4:5:6:7:8::', 'g::1', '12345::1']) expect(() => expandV6(bad)).toThrow();
    expect(ipv6Bucket('[2001:db8:aa:bb:1:2:3:4]')).toBe('2001:db8:aa:bb::/64');
    expect(ipv6Bucket('[::ffff:cb00:7107]')).toBe('203.0.113.7');
  });
  it('counts the public daily allowance per IPv6 /64 and keeps IPv4-mapped addresses equal to IPv4', async () => {
    const request = ip => new Request('https://scanner.example/', { headers: { 'CF-Connecting-IP': ip } });
    const hash = await dailyIpHash(request('2001:db8:1:2::1'), env);
    expect(await dailyIpHash(request('2001:db8:1:2:ffff:eeee:dddd:cccc'), env)).toBe(hash);
    expect(await dailyIpHash(request('2001:0db8:0001:0002:0000:0000:0000:0099'), env)).toBe(hash);
    expect(await dailyIpHash(request('2001:db8:1:3::1'), env)).not.toBe(hash);
    expect(await dailyIpHash(request('::ffff:203.0.113.7'), env)).toBe(await dailyIpHash(request('203.0.113.7'), env));
    for (let i = 0; i < 3; i++) expect((await permit({ 'CF-Connecting-IP': `2001:db8:9:9::${i + 1}` })).status).toBe(200);
    const fourth = await permit({ 'CF-Connecting-IP': '2001:db8:9:9:abcd::1' });
    expect(fourth.status).toBe(429);
    expect(fourth.data.code).toBe('scan_limit_reached');
    expect((await permit({ 'CF-Connecting-IP': '2001:db8:9:a::1' })).status).toBe(200);
  });
  it('resets public scan allowance at UTC midnight without reusing the previous ticket', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-25T23:59:00Z'));
    const id = crypto.randomUUID();
    const first = await permit({}, id); await permit(); await permit();
    expect((await permit()).status).toBe(429);
    vi.setSystemTime(new Date('2026-09-26T00:00:01Z'));
    const next = await permit({}, id);
    expect(next.status).toBe(200); expect(next.data.search_ticket).not.toBe(first.data.search_ticket);
    expect(next.data.remaining_scans).toBe(2);
  });
});

describe('content-free operator usage and cleanup', () => {
  it.each(['not JSON private provider body', JSON.stringify({ error: 'private provider error' }), JSON.stringify({ search_metadata: { status: 'Error' } })])('counts unsuccessful HTTP200 autocomplete as failure without exposing its body', async body => {
    const { data } = await permit();
    fetch.mockResolvedValueOnce(new Response(body));
    const response = await api('/api/search', 'POST', { ...query, kind: 'autocomplete', search_ticket: data.search_ticket });
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.data)).not.toMatch(/private provider|not JSON/);
    expect(sqlite.prepare('SELECT search_attempts, search_successes, search_failures FROM private_usage_summary').get()).toEqual({ search_attempts: 1, search_successes: 0, search_failures: 1 });
  });
  it('requires an operator session and reports actual starts/attempts/outcomes, estimates, and zero AI usage', async () => {
    expect((await api('/api/operator/usage')).status).toBe(401);
    const publicPermit = await permit(); await relay(publicPermit.data.search_ticket);
    const { cookie } = await login(), headers = { Cookie: cookie };
    const operatorPermit = await permit(headers);
    fetch.mockResolvedValueOnce(new Response('private error', { status: 500 }));
    await relay(operatorPermit.data.search_ticket, headers);
    const response = await api('/api/operator/usage', 'GET', undefined, headers);
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ cloud_ai_enabled: false, public_daily_limit: 3, operator_daily_limit: null, retention_days: 30 });
    expect(response.data.today).toMatchObject({ date: utcDay(),
      public: { scan_starts: 1, search_attempts: 1, search_successes: 1, search_failures: 0, estimated_search_cost_usd: 0.001, in_tokens: 0, out_tokens: 0, tokens: 0, ai_cost_usd: 0 },
      operator: { scan_starts: 1, search_attempts: 1, search_successes: 0, search_failures: 1, estimated_search_cost_usd: 0.001 } });
    expect(response.data.days).toHaveLength(30);
    expect(response.data.providers).toEqual([{ provider: 'serpapi', cost_per_1000_queries: 1, estimated: true }]);
    expect(JSON.stringify(response.data)).not.toMatch(/Example Person|publisher\.example|token_hash|owner_hash|synthetic/);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM private_usage_daily').get().n).toBe(0);
    for (const table of ['scans', 'hits', 'queries', 'requests', 'assistance_requests']) expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(0);
  });
  it('scheduled cleanup deletes expired auth/old pseudonymous metadata and limits summaries and assistance requests to 30 days', async () => {
    const old = Date.now() - 3 * 86400000, yesterday = Date.now() - 86400000;
    sqlite.prepare('INSERT INTO operator_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run('oldsession', old, old + 1);
    sqlite.prepare('INSERT INTO operator_login_limits VALUES (?, ?, ?, ?)').run(utcDay(old), 'oldhash', 1, 2);
    sqlite.prepare('INSERT INTO operator_login_limits VALUES (?, ?, ?, ?)').run(utcDay(yesterday), 'recenthash', 1, 2);
    sqlite.prepare("INSERT INTO search_permits (ticket_hash,day,owner_hash,mode,provider,created_at,expires_at,max_requests) VALUES (?, ?, ?, 'public','serpapi',?,?,26)").run('oldticket', utcDay(old), 'oldhash', old, old + 1);
    sqlite.prepare("INSERT INTO private_usage_summary (day,mode,provider,scan_starts) VALUES (?, 'public','serpapi',4)").run(utcDay(Date.now() - 30 * 86400000));
    const assistance = sqlite.prepare("INSERT INTO assistance_requests (id, created_at, name, email, message, help_type, consent_version, delivered) VALUES (?, ?, 'Reporter', 'test@example.test', 'text', 'unsure', 'v2', ?)");
    assistance.run('expired-undelivered', 0, 0);
    assistance.run('expired-receipt', Date.now() - 31 * 86400000, 1);
    assistance.run('recent-undelivered', Date.now() - 29 * 86400000, 0);
    await worker.scheduled({}, env);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM operator_sessions').get().n).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM search_permits').get().n).toBe(0);
    expect(sqlite.prepare('SELECT * FROM operator_login_limits').all()).toHaveLength(1);
    expect(sqlite.prepare('SELECT day, scan_starts FROM private_usage_summary').all()).toEqual([{ day: utcDay(old), scan_starts: 1 }]);
    expect(sqlite.prepare('SELECT id FROM assistance_requests').all().map(row => row.id)).toEqual(['recent-undelivered']);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('separate backup provider accounting', () => {
  const request = () => new Request('https://scanner.example/api/search', { headers: { 'CF-Connecting-IP': address } });
  const operator = () => ({ token_hash: 'synthetic-resolved-operator', expires_at: Date.now() + 3_600_000 });
  const backup = (extra = {}) => ({ usageProvider: 'serpapi', costPer1000: 0, dailyProviderLimit: 50, ...extra });
  const ticket = async (mode = null, provider = 'searxng') => (await startSearchSession(request(), env, mode,
    crypto.randomUUID(), provider)).search_ticket;

  it('binds a backup reservation to the primary permit and charges outcomes to the actual backup provider', async () => {
    env.SERP_COST_PER_1K = 0;
    const primaryTicket = await ticket();
    await expect(reserveRelay(request(), env, null, primaryTicket, 'serpapi', backup())).rejects.toMatchObject({
      status: 403, details: { code: 'search_ticket_invalid' } });
    expect(sqlite.prepare('SELECT requests FROM search_permits').get().requests).toBe(0);
    const reservation = await reserveRelay(request(), env, null, primaryTicket, 'searxng', backup({ costPer1000: 12 }));
    expect(reservation).toEqual({ day: utcDay(), mode: 'public', provider: 'serpapi' });
    await finishRelay(env, reservation, true);
    expect(sqlite.prepare("SELECT provider, scan_starts, search_attempts, search_successes, estimated_search_cost_usd FROM private_usage_summary ORDER BY provider").all()).toEqual([
      { provider: 'searxng', scan_starts: 1, search_attempts: 0, search_successes: 0, estimated_search_cost_usd: 0 },
      { provider: 'serpapi', scan_starts: 0, search_attempts: 1, search_successes: 1, estimated_search_cost_usd: 0.012 },
    ]);
    expect(sqlite.prepare('SELECT provider, requests FROM search_permits').get()).toEqual({ provider: 'searxng', requests: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enforces one backup quota atomically across concurrent public and operator reservations', async () => {
    const mode = operator(), publicTicket = await ticket(), operatorTicket = await ticket(mode);
    const options = backup({ dailyProviderLimit: 5 });
    await reserveRelay(request(), env, null, publicTicket, 'searxng', options);
    await reserveRelay(request(), env, mode, operatorTicket, 'searxng', options);
    const results = await Promise.allSettled(Array.from({ length: 16 }, (_, index) => reserveRelay(request(), env,
      index % 2 ? mode : null, index % 2 ? operatorTicket : publicTicket, 'searxng', options)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(3);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(13);
    for (const result of results.filter(result => result.status === 'rejected')) expect(result.reason).toMatchObject({
      status: 429, details: { code: 'daily_search_limit' } });
    const totals = sqlite.prepare("SELECT mode, search_attempts FROM private_usage_summary WHERE provider = 'serpapi'").all();
    expect(totals.reduce((count, row) => count + row.search_attempts, 0)).toBe(5);
    expect(totals.every(row => row.search_attempts >= 1)).toBe(true);
    expect(sqlite.prepare("SELECT SUM(search_attempts) AS n FROM private_usage_summary WHERE provider = 'searxng'").get().n).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('applies an explicit backup cap even when an operator bypasses both global public caps', async () => {
    env.DAILY_SERP_LIMIT = 0; env.DAILY_USD_LIMIT = 0;
    const mode = operator(), operatorTicket = await ticket(mode);
    const options = backup({ dailyProviderLimit: 1, costPer1000: 2 });
    const reserved = await reserveRelay(request(), env, mode, operatorTicket, 'searxng', options);
    await finishRelay(env, reserved, false);
    await expect(reserveRelay(request(), env, mode, operatorTicket, 'searxng', options)).rejects.toMatchObject({ status: 429 });
    expect(sqlite.prepare("SELECT search_attempts, search_failures, estimated_search_cost_usd FROM private_usage_summary WHERE provider = 'serpapi'").get())
      .toEqual({ search_attempts: 1, search_failures: 1, estimated_search_cost_usd: 0.002 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the global public count cap across primary and backup providers', async () => {
    env.DAILY_SERP_LIMIT = 1;
    const primaryTicket = await ticket();
    await reserveRelay(request(), env, null, primaryTicket, 'searxng');
    await expect(reserveRelay(request(), env, null, primaryTicket, 'searxng', backup())).rejects.toMatchObject({
      status: 429, details: { code: 'daily_search_limit' } });
    expect(sqlite.prepare("SELECT SUM(search_attempts) AS n FROM private_usage_summary WHERE mode = 'public'").get().n).toBe(1);
    expect(sqlite.prepare("SELECT search_attempts FROM private_usage_summary WHERE provider = 'serpapi'").get().search_attempts).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the global public spend cap when backup costs differ from the primary estimate', async () => {
    env.SERP_COST_PER_1K = 0; env.DAILY_USD_LIMIT = 0.002;
    const primaryTicket = await ticket(), options = backup({ costPer1000: 2 });
    await reserveRelay(request(), env, null, primaryTicket, 'searxng');
    await reserveRelay(request(), env, null, primaryTicket, 'searxng', options);
    await expect(reserveRelay(request(), env, null, primaryTicket, 'searxng', options)).rejects.toMatchObject({ status: 429 });
    expect(sqlite.prepare("SELECT search_attempts, estimated_search_cost_usd FROM private_usage_summary WHERE provider = 'serpapi'").get())
      .toEqual({ search_attempts: 1, estimated_search_cost_usd: 0.002 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves default primary-provider accounting and allows an explicit zero provider limit', async () => {
    const primaryTicket = await ticket();
    expect(await reserveRelay(request(), env, null, primaryTicket, 'searxng')).toMatchObject({ provider: 'searxng' });
    await expect(reserveRelay(request(), env, null, primaryTicket, 'searxng', backup({ dailyProviderLimit: 0 }))).rejects.toMatchObject({ status: 429 });
    expect(sqlite.prepare("SELECT search_attempts, estimated_search_cost_usd FROM private_usage_summary WHERE provider = 'searxng'").get())
      .toEqual({ search_attempts: 1, estimated_search_cost_usd: 0.001 });
    expect(sqlite.prepare("SELECT search_attempts FROM private_usage_summary WHERE provider = 'serpapi'").get().search_attempts).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([null, [], 'invalid', { extra: true }, { usageProvider: 'Private Person' }, { usageProvider: 'https://private.example' },
    { costPer1000: -1 }, { costPer1000: NaN }, { costPer1000: Infinity }, { costPer1000: '2' }, { costPer1000: null },
    { dailyProviderLimit: -1 }, { dailyProviderLimit: 1.5 }, { dailyProviderLimit: Infinity }, { dailyProviderLimit: '50' },
    { dailyProviderLimit: null }, { dailyProviderLimit: false }])('rejects malformed server accounting options before consuming a permit: %j', async options => {
    const primaryTicket = await ticket();
    await expect(reserveRelay(request(), env, null, primaryTicket, 'searxng', options)).rejects.toMatchObject({ status: 503 });
    expect(sqlite.prepare('SELECT requests FROM search_permits').get().requests).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM private_usage_summary').get().n).toBe(1);
    expect(sqlite.prepare('SELECT search_attempts FROM private_usage_summary').get().search_attempts).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports a configured backup separately and explains that a zero estimate is not verified free usage', async () => {
    Object.assign(env, { GOOGLE_BACKUP_PROVIDER: 'serpapi', GOOGLE_BACKUP_COST_PER_1K: '0', GOOGLE_BACKUP_DAILY_LIMIT: '50' });
    const data = await usageDashboard(env, 'searxng');
    expect(data.providers).toEqual([
      { provider: 'searxng', cost_per_1000_queries: 1, estimated: true },
      { provider: 'serpapi', cost_per_1000_queries: 0, estimated: true, role: 'backup', daily_query_limit: 50,
        estimate_supplied: false, estimate_notice: 'No cost estimate supplied. A zero estimate does not establish that the backup provider is free.' },
    ]);
    env.GOOGLE_BACKUP_COST_PER_1K = '6.5';
    expect((await usageDashboard(env, 'searxng')).providers[1]).toMatchObject({ cost_per_1000_queries: 6.5, estimate_supplied: true,
      estimate_notice: 'Configured estimate; actual provider billing may differ.' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
