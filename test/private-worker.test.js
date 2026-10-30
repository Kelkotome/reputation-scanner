import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/private-worker.js';
import { SEARCH_RESULT_LIMIT } from '../src/search-limits.js';
import { dailyIpHash, digest, nextUtc, utcDay } from '../src/operator-access.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
let sqlite, env, statements;
const relayBody = { q: 'Example Person complaint', country_code: '', kind: 'search' };
const testTickets = { serpapi: 'a'.repeat(64), searxng: 'b'.repeat(64) };
const assistanceBody = { consent: true, name: 'Example Reporter', email: 'reporter@example.test', message: 'Please help me review my options.', help_type: 'unsure' };
const sharedReport = { subject_name: 'Example Person', subject_type: 'person', country: 'Singapore', results: [{ url: 'https://publisher.example/story?content=exact#item', title: 'Example result' }] };
const legacyTables = ['scans', 'hits', 'queries', 'drafts', 'requests', 'serp_cache', 'scan_cache', 'usage_daily', 'ip_daily', 'takedown_cases', 'takedown_items'];

function prepare(sql, args = []) {
  const log = () => statements.push({ sql, args });
  return {
    bind: (...values) => prepare(sql, values),
    first: async () => { log(); return sqlite.prepare(sql).get(...args) || null; },
    run: async () => { log(); const r = sqlite.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  };
}
async function api(path, method = 'GET', data, headers = {}) {
  // These transport tests start with pre-issued permits. Quota/auth lifecycle
  // behavior is covered separately through the actual public session endpoint.
  if (path === '/api/search' && data) data = { search_ticket: testTickets[env.SERP_PROVIDER] || testTickets.serpapi, ...data };
  const response = await worker.fetch(new Request(`https://scanner.example${path}`, { method,
    headers: { 'CF-Connecting-IP': '203.0.113.7', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), env);
  return { status: response.status, data: await response.json(), headers: response.headers };
}
function assertNoLegacyContent() {
  for (const table of legacyTables) expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, table).toBe(0);
}
function poisonDatabase() { Object.defineProperty(env, 'DB', { configurable: true, get() { throw new Error('Database must not be accessed'); } }); }
function enableRelay() { env.ALLOW_SEARCH_RELAY = 'true'; }
function successfulProvider() {
  fetch.mockResolvedValue(Response.json({ organic_results: [{ title: 'Example Person complaint', link: 'https://publisher.example/story', snippet: 'A text result.' }] }, { status: 200 }));
}
beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  statements = [];
  env = { DB: { prepare }, SERP_PROVIDER: 'serpapi', SERP_API_KEY: 'test-provider-secret', RATE_LIMIT_SECRET: 'synthetic-rate-limit-secret-32-chars-long',
    CLOUD_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-ai-secret', OPENAI_API_KEY: 'test-other-ai-secret',
    ASSETS: { fetch: vi.fn(() => new Response('static asset')) } };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external request in offline test'); }));
  const owner = await dailyIpHash(new Request('https://scanner.example/', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }), env);
  for (const [provider, ticket] of Object.entries(testTickets)) sqlite.prepare(`INSERT INTO search_permits
    (ticket_hash, day, owner_hash, mode, provider, created_at, expires_at, max_requests) VALUES (?, ?, ?, 'public', ?, ?, ?, 26)`)
    .run(await digest(ticket), utcDay(), owner, provider, Date.now(), nextUtc());
  sqlite.prepare('DELETE FROM private_usage_summary').run(); // Transport fixtures predate this test's accounting window.
});
afterEach(() => { vi.unstubAllGlobals(); sqlite.close(); });

describe('browser-only active worker boundary', () => {
  it('serves public configuration without database, cloud AI or network access', async () => {
    poisonDatabase();
    env.MAX_QUERIES = '600'; env.SHOW_LIMIT = '100';
    expect((await api('/api/config')).data).toEqual({ storage: 'browser', demo: false, provider: 'serpapi', cloud_ai_enabled: false, ai_drafting_enabled: false, ai_provider_name: null, search_relay_enabled: false, search_country_supported: true, autocomplete_supported: true, max_queries: 60, show_limit: 20, operator: false, partner: null, public_daily_limit: 3, scan_ticket_required: true, quota_reset_hour_utc: 0, reset_at: nextUtc(), abuse_protection_enabled: false, bot_check_required: false, bot_check_configured: false, turnstile_site_key: null, scan_cooldown_seconds: 0 });
    env.SHOW_LIMIT = '15';
    expect((await api('/api/config')).data.show_limit).toBe(15);
    delete env.SHOW_LIMIT;
    expect((await api('/api/config')).data.show_limit).toBe(20);
    env.SERP_PROVIDER = 'mock'; enableRelay();
    expect((await api('/api/config')).data).toMatchObject({ demo: true, search_relay_enabled: false });
    expect((await api('/api/help-links')).data.links.length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['/api/scan', 'POST'], ['/api/scan/old-id', 'GET'], ['/api/scan/old-id', 'DELETE'],
    ['/api/scan/old-id/import', 'POST'], ['/api/scan/old-id/retry', 'POST'], ['/api/scan/old-id/queries', 'GET'],
    ['/api/hit/12', 'PATCH'], ['/api/hit/12/draft', 'POST'], ['/api/takedowns', 'POST'],
    ['/api/takedowns/old-id', 'GET'], ['/api/takedowns/old-id/items/1', 'PATCH'], ['/api/takedowns/old-id', 'DELETE'],
    ['/api/import', 'POST'], ['/api/help', 'POST'], ['/api/unlock', 'POST'],
  ])('retires %s %s before database or request-body access', async (path, method) => {
    poisonDatabase();
    const request = new Request(`https://scanner.example${path}`, { method, ...(method === 'GET' ? {} : { body: 'unparsed sensitive legacy payload', headers: { 'Content-Type': 'text/plain' } }) });
    const response = await worker.fetch(request, env);
    expect(response.status).toBe(410);
    expect(request.bodyUsed).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not expose assistance readback or fall through unknown APIs to legacy handlers', async () => {
    poisonDatabase();
    for (const path of ['/api/assistance', '/api/assistance/guess', '/api/unknown', '/api/search']) expect((await api(path)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('delegates only non-API paths to static assets', async () => {
    poisonDatabase();
    const response = await worker.fetch(new Request('https://scanner.example/report.html'), env);
    expect(await response.text()).toBe('static asset');
    expect(env.ASSETS.fetch).toHaveBeenCalledOnce();
  });
});

describe('explicitly enabled query-only relay', () => {
  it.each([undefined, 'false', true, 'TRUE'])('fails closed with relay setting %s even when credentials exist', async value => {
    env.ALLOW_SEARCH_RELAY = value; poisonDatabase();
    const request = new Request('https://scanner.example/api/search', { method: 'POST', body: 'not JSON' });
    expect((await worker.fetch(request, env)).status).toBe(403);
    expect(request.bodyUsed).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['mock', 'session', 'unknown'])('never proxies the %s provider', async provider => {
    enableRelay(); env.SERP_PROVIDER = provider; poisonDatabase();
    expect((await api('/api/search', 'POST', relayBody)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('passes only the bounded query and canonical country, strips provider metadata, and persists only anonymous totals', async () => {
    enableRelay();
    fetch.mockResolvedValue(Response.json({
      search_metadata: { raw: 'private provider metadata', api_key: 'test-provider-secret' },
      organic_results: [
        { title: '<b>Example Person</b>', link: 'https://publisher.example/story?ref=exact', snippet: 'A <em>text</em> result.', thumbnail: 'https://media.example/image.jpg', extra: 'not exposed' },
        { title: 'Unsafe', link: 'javascript:alert(1)' },
        { title: 'Internal', link: 'http://127.0.0.1/private' },
        { title: 'Credentials', link: 'https://user:password@publisher.example/' },
      ], related_searches: [{ query: 'unrequested related content' }], images_results: [{ original: 'https://media.example/image.jpg' }],
    }));
    const result = await api('/api/search', 'POST', { ...relayBody, country_code: 'GB' });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ results: [{ title: 'Example Person', url: 'https://publisher.example/story?ref=exact', snippet: 'A text result.' }], related: [],
      coverage: { returned: 4, invalid: 3, limited: 0, engines: ['google'] } });
    const providerUrl = new URL(fetch.mock.calls[0][0]);
    expect(providerUrl.origin).toBe('https://serpapi.com');
    expect(providerUrl.searchParams.get('q')).toBe(relayBody.q);
    expect(providerUrl.searchParams.get('gl')).toBe('uk');
    expect(fetch.mock.calls[0][1].redirect).toBe('manual');
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
    expect(sqlite.prepare('SELECT search_attempts AS search_count, estimated_search_cost_usd AS cost_usd FROM private_usage_summary').get()).toMatchObject({ search_count: 1, cost_usd: 0.001 });
    expect(JSON.stringify(statements)).not.toMatch(/Example Person|test-provider-secret|reporter@|publisher\.example/);
    expect(statements.every(statement => /search_permits|private_usage_summary/.test(statement.sql))).toBe(true);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM assistance_requests').get().n).toBe(0);
    assertNoLegacyContent();
  });
  it('retains later web entries from other providers up to the shared cap with fallback coverage counts', async () => {
    enableRelay();
    const organic_results = Array.from({ length: SEARCH_RESULT_LIMIT + 7 }, (_, i) => ({
      title: `Example Person result ${i}`, link: `https://publisher.example/story/${i}`, snippet: 'A text result.',
      engines: ['private-provider-secret'], coverage: { returned: -1, limited: 1000000 } }));
    organic_results.splice(25, 0, { title: 'Unsafe late result', link: 'http://127.0.0.1/private' });
    fetch.mockResolvedValue(Response.json({ organic_results, coverage: { returned: -1 }, engines: ['private-provider-secret'] }));
    const response = await api('/api/search', 'POST', relayBody);
    expect(response.status).toBe(200);
    expect(response.data.results).toHaveLength(SEARCH_RESULT_LIMIT);
    expect(response.data.results.some(item => item.url === 'https://publisher.example/story/26')).toBe(true);
    expect(response.data.coverage).toEqual({ returned: 108, invalid: 1, limited: 7, engines: ['google'] });
    expect(JSON.stringify(response.data)).not.toMatch(/private-provider-secret|127\.0\.0\.1/);
    assertNoLegacyContent();
  });
  it('passes an explicit no-country preference instead of the legacy Singapore default', async () => {
    enableRelay(); env.SERP_GL = 'sg'; successfulProvider();
    expect((await api('/api/search', 'POST', relayBody)).status).toBe(200);
    expect(new URL(fetch.mock.calls[0][0]).searchParams.has('gl')).toBe(false);
  });
  it('returns only text autocomplete suggestions and counts the request', async () => {
    enableRelay();
    fetch.mockResolvedValue(Response.json({ suggestions: [{ value: '<b>Example Person</b> review', thumbnail: 'media' }, { value: 23 }, { value: 'Example Person complaint' }], metadata: { private: true } }));
    const result = await api('/api/search', 'POST', { ...relayBody, kind: 'autocomplete' });
    expect(result.data).toEqual({ suggestions: ['Example Person review', 'Example Person complaint'] });
    expect(new URL(fetch.mock.calls[0][0]).searchParams.get('engine')).toBe('google_autocomplete');
    expect(sqlite.prepare('SELECT search_attempts AS search_count FROM private_usage_summary').get().search_count).toBe(1);
    assertNoLegacyContent();
  });
  it('keeps autocomplete at twenty suggestions despite the larger web-result cap', async () => {
    enableRelay();
    fetch.mockResolvedValue(Response.json({ suggestions: Array.from({ length: 30 }, (_, i) => ({ value: `Example Person suggestion ${i}` })) }));
    const response = await api('/api/search', 'POST', { ...relayBody, kind: 'autocomplete' });
    expect(response.status).toBe(200);
    expect(response.data.suggestions).toHaveLength(20);
    expect(Object.keys(response.data)).toEqual(['suggestions']);
  });
  it.each([
    { scan_id: 'local-id' }, { full_name: 'Extra private identity' }, { urls: ['https://publisher.example/'] },
    { q: 'x'.repeat(501) }, { q: '' }, { q: 42 }, { country_code: 'not-a-country' }, { country_code: null }, { kind: 'image' },
  ])('rejects extra or invalid relay fields before storage or outbound calls: %j', async patch => {
    enableRelay(); poisonDatabase();
    expect((await api('/api/search', 'POST', { ...relayBody, ...patch })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['Example nudes', 'Example intimate images', 'Example sex tape', 'Example sextape', 'Example porn', 'Example 裸照', 'Example site:onlyfans.com', 'Example ｎｕｄｅｓ', 'Example nu\u200bdes'])('rejects intimate discovery query %s without storage or outbound calls', async q => {
    enableRelay(); poisonDatabase();
    expect((await api('/api/search', 'POST', { ...relayBody, q })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects missing fields, URL query payloads, cross-origin calls and non-JSON content', async () => {
    enableRelay(); poisonDatabase();
    expect((await api('/api/search', 'POST', { q: 'Example', kind: 'search' })).status).toBe(400);
    expect((await api('/api/search?q=private', 'POST', relayBody)).status).toBe(400);
    for (const headers of [{ Origin: 'https://other.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) expect((await api('/api/search', 'POST', relayBody, headers)).status).toBe(403);
    expect((await api('/api/search', 'POST', relayBody, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('caps streamed JSON at 32 KiB even without Content-Length', async () => {
    enableRelay(); poisonDatabase();
    const request = new Request('https://scanner.example/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: '世'.repeat(12000) }) });
    expect(request.headers.has('Content-Length')).toBe(false);
    expect((await worker.fetch(request, env)).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reserves atomically across parallel requests and never exceeds the query cap', async () => {
    enableRelay(); env.DAILY_SERP_LIMIT = 3; successfulProvider();
    // Return a fresh body to every consumer.
    fetch.mockImplementation(async () => Response.json({ organic_results: [] }));
    const results = await Promise.all(Array.from({ length: 8 }, () => api('/api/search', 'POST', relayBody)));
    expect(results.filter(result => result.status === 200)).toHaveLength(3);
    expect(results.filter(result => result.status === 429)).toHaveLength(5);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sqlite.prepare('SELECT search_attempts AS search_count, estimated_search_cost_usd AS cost_usd FROM private_usage_summary').get()).toMatchObject({ search_count: 3, cost_usd: 0.003 });
    assertNoLegacyContent();
  });
  it.each([{ DAILY_SERP_LIMIT: 0 }, { DAILY_USD_LIMIT: 0 }, { DAILY_USD_LIMIT: 0.0009 }])('respects numeric zero and insufficient remaining spend: %j', async limits => {
    enableRelay(); Object.assign(env, limits);
    expect((await api('/api/search', 'POST', relayBody)).status).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps failed calls reserved and exposes neither provider errors nor credentials', async () => {
    enableRelay();
    fetch.mockResolvedValue(new Response('test-provider-secret Example Person raw private provider response', { status: 403 }));
    const result = await api('/api/search', 'POST', relayBody);
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.data)).not.toMatch(/secret|Example Person|raw private/);
    expect(sqlite.prepare('SELECT search_attempts AS search_count FROM private_usage_summary').get().search_count).toBe(1);
    expect(JSON.stringify(statements)).not.toContain(relayBody.q);
    assertNoLegacyContent();
  });
  it.each(['serpapi', 'searxng'])('blocks %s redirects at the Worker boundary without following or exposing Location', async provider => {
    enableRelay();
    env.SERP_PROVIDER = provider;
    Object.assign(env, { SEARXNG_URL: 'https://search.example/', SEARXNG_TOKEN: 'synthetic-instance-token', SEARXNG_ENGINES: 'google cse' });
    const cancel = vi.fn();
    fetch.mockResolvedValue(new Response(new ReadableStream({ cancel }), {
      status: 302, headers: { Location: 'https://untrusted.example/query?secret=synthetic-private-token' },
    }));
    const result = await api('/api/search', 'POST', relayBody);
    expect(result.status).toBe(502);
    expect(JSON.stringify(result.data)).not.toMatch(/untrusted|synthetic-private-token|Example Person/);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].redirect).toBe('manual');
    expect(cancel).toHaveBeenCalledOnce();
    expect(sqlite.prepare('SELECT search_attempts AS search_count FROM private_usage_summary').get().search_count).toBe(1);
    assertNoLegacyContent();
  });
  it('does not make an external call when the anonymous reservation fails', async () => {
    enableRelay(); poisonDatabase();
    expect((await api('/api/search', 'POST', relayBody)).status).toBe(500);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('private SearXNG relay', () => {
  function configureSearxng() {
    Object.assign(env, { SERP_PROVIDER: 'searxng', SEARXNG_URL: 'https://search.example/',
      SEARXNG_TOKEN: 'synthetic-instance-token', SEARXNG_ENGINES: 'google cse' });
    delete env.SERP_API_KEY;
  }
  function configureBackup() {
    configureSearxng(); enableRelay();
    Object.assign(env, { SEARXNG_ENGINES: 'google,bing,google cse', GOOGLE_BACKUP_PROVIDER: 'serpapi',
      SERPAPI_API_KEY: 'synthetic-backup-secret', GOOGLE_BACKUP_DAILY_LIMIT: '50', GOOGLE_BACKUP_COST_PER_1K: '' });
  }
  const bingResponse = () => Response.json({ results: [{ title: 'Neutral Bing listing', url: 'https://publisher.example/bing', engine: 'bing' }] });
  const backupResponse = () => Response.json({ organic_results: [{ title: 'Neutral Google listing', link: 'https://publisher.example/google', snippet: 'Public text' }] });
  it('uses a consented SerpApi backup once for missing Google, preserves Bing, and meters providers separately', async () => {
    configureBackup(); fetch.mockImplementationOnce(async () => bingResponse()).mockImplementationOnce(async () => backupResponse());
    const response = await api('/api/search', 'POST', { ...relayBody, page: 3, google_backup_consent: true });
    expect(response.status).toBe(200);
    expect(response.data.results.map(item => item.url)).toEqual(['https://publisher.example/bing', 'https://publisher.example/google']);
    expect(response.data.coverage).toMatchObject({ returned: 2, engines: ['bing', 'google'], google_recovery: 'recovered', attempts: 2, google_backup_provider: 'serpapi' });
    expect(fetch).toHaveBeenCalledTimes(2);
    const target = new URL(fetch.mock.calls[1][0]);
    expect(target.origin).toBe('https://serpapi.com');
    expect(target.searchParams.get('q')).toBe(relayBody.q);
    expect(target.searchParams.get('start')).toBe('20');
    expect(target.searchParams.get('no_cache')).toBe('true');
    expect(target.searchParams.get('api_key')).toBe('synthetic-backup-secret');
    expect(target.searchParams.has('gl')).toBe(false);
    for (const provider of ['searxng', 'serpapi']) expect(sqlite.prepare('SELECT search_attempts,search_successes FROM private_usage_summary WHERE provider=?').get(provider))
      .toMatchObject({ search_attempts: 1, search_successes: 1 });
    expect(JSON.stringify(response.data)).not.toMatch(/synthetic-backup-secret|search\.example|thumbnail/);
    expect(JSON.stringify(statements)).not.toMatch(/Example Person|synthetic-backup-secret|publisher\.example/);
    assertNoLegacyContent();
  });
  it.each([undefined, false])('does not send legacy or unconsented queries to the backup (%s)', async consent => {
    configureBackup(); fetch.mockImplementation(async () => bingResponse());
    const response = await api('/api/search', 'POST', { ...relayBody, ...(consent === undefined ? {} : { google_backup_consent: consent }) });
    expect(response.status).toBe(200); expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => new URL(url).origin === 'https://search.example')).toBe(true);
    expect(response.data.coverage).not.toHaveProperty('google_backup_provider');
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM private_usage_summary WHERE provider='serpapi'").get().n).toBe(0);
  });
  it('skips the backup when its separate daily cap is exhausted and preserves primary results', async () => {
    configureBackup(); env.GOOGLE_BACKUP_DAILY_LIMIT='0'; fetch.mockImplementation(async () => bingResponse());
    const response = await api('/api/search', 'POST', { ...relayBody, google_backup_consent: true });
    expect(response.status).toBe(200); expect(fetch).toHaveBeenCalledOnce(); expect(response.data.results).toHaveLength(1);
    expect(response.data.coverage).toMatchObject({ google_backup_provider: 'serpapi', google_recovery: 'budget_skipped', attempts: 1 });
  });
  it('retains Bing when SerpApi fails and settles the failed backup separately', async () => {
    configureBackup(); fetch.mockImplementationOnce(async () => bingResponse()).mockImplementationOnce(async () => new Response('PRIVATE ERROR', {status:401}));
    const response=await api('/api/search','POST',{...relayBody,google_backup_consent:true});
    expect(response.status).toBe(200); expect(response.data.results).toHaveLength(1);
    expect(response.data.coverage).toMatchObject({google_backup_provider:'serpapi',google_recovery:'failed',attempts:2});
    expect(sqlite.prepare("SELECT search_attempts,search_failures FROM private_usage_summary WHERE provider='serpapi'").get()).toMatchObject({search_attempts:1,search_failures:1});
    expect(JSON.stringify(response.data)).not.toMatch(/PRIVATE ERROR|synthetic-backup-secret/);
  });
  it('can use the independent backup after a failed primary while preserving incomplete coverage', async () => {
    configureBackup(); fetch.mockImplementationOnce(async () => new Response('PRIVATE ERROR',{status:503})).mockImplementationOnce(async()=>backupResponse());
    const response=await api('/api/search','POST',{...relayBody,google_backup_consent:true});
    expect(response.status).toBe(200); expect(response.data.partial).toBe(true);
    expect(response.data.coverage).toMatchObject({primary_failed:true,google_backup_provider:'serpapi',google_recovery:'recovered',attempts:2});
    expect(sqlite.prepare("SELECT search_failures FROM private_usage_summary WHERE provider='searxng'").get().search_failures).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not request backup when SearXNG already supplied Google listings', async () => {
    configureBackup(); fetch.mockImplementation(async()=>Response.json({results:[{title:'Google listing',url:'https://publisher.example/google',engine:'google'}]}));
    const response=await api('/api/search','POST',{...relayBody,google_backup_consent:true});
    expect(response.status).toBe(200); expect(fetch).toHaveBeenCalledOnce();expect(response.data.coverage).not.toHaveProperty('google_backup_provider');
  });
  it('exposes backup readiness without exposing the key', async () => {
    configureBackup(); poisonDatabase();
    const response=await api('/api/config');
    expect(response.data).toMatchObject({provider:'searxng',google_backup_provider:'serpapi',google_backup_available:true});
    expect(JSON.stringify(response.data)).not.toMatch(/synthetic-backup-secret|SERPAPI_API_KEY/);
    delete env.SERPAPI_API_KEY;
    expect((await api('/api/config')).data).toMatchObject({google_backup_provider:'serpapi',google_backup_available:false});
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['true',1,null])('rejects invalid backup consent %s before database or network',async consent=>{
    configureBackup();poisonDatabase();
    expect((await api('/api/search','POST',{...relayBody,google_backup_consent:consent})).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('recovers a silent Google miss once through the same provider, metering both attempts and preserving the first listings', async () => {
    configureSearxng(); enableRelay(); env.SEARXNG_ENGINES = 'google,bing,google cse';
    fetch.mockImplementationOnce(async () => Response.json({ results: [{ title: 'Initial Bing listing', url: 'https://publisher.example/initial', content: '', engine: 'bing' }] }))
      .mockImplementationOnce(async () => Response.json({ results: [{ title: 'Resultado de Google', url: 'https://publisher.example/spanish', content: '', engine: 'google' }] }));
    const response = await api('/api/search', 'POST', { ...relayBody, page: 2 });
    expect(response.status).toBe(200);
    expect(response.data.results.map(item => item.url)).toEqual(['https://publisher.example/initial', 'https://publisher.example/spanish']);
    expect(response.data.coverage).toMatchObject({ returned: 2, engines: ['bing', 'google'], google_recovery: 'recovered', attempts: 2 });
    expect(fetch).toHaveBeenCalledTimes(2);
    const retry = new URLSearchParams(fetch.mock.calls[1][1].body);
    expect(Object.fromEntries(retry)).toMatchObject({ q: relayBody.q, engines: 'google', language: 'all', pageno: '2' });
    expect(sqlite.prepare("SELECT search_attempts,search_successes,search_failures FROM private_usage_summary WHERE provider='searxng'").get())
      .toMatchObject({ search_attempts: 2, search_successes: 2, search_failures: 0 });
    assertNoLegacyContent();
  });
  it('keeps initial results when a silent-Google retry fails, without another attempt or raw provider errors', async () => {
    configureSearxng(); enableRelay(); env.SEARXNG_ENGINES = 'google,bing';
    fetch.mockImplementationOnce(async () => Response.json({ results: [{ title: 'Initial', url: 'https://publisher.example/initial', engine: 'bing' }] }))
      .mockImplementationOnce(async () => new Response('PRIVATE PROVIDER ERROR', { status: 429 }));
    const response = await api('/api/search', 'POST', relayBody);
    expect(response.status).toBe(200);
    expect(response.data.results).toHaveLength(1);
    expect(response.data.coverage).toMatchObject({ attempts: 2, google_recovery: 'failed' });
    expect(JSON.stringify(response.data)).not.toContain('PRIVATE PROVIDER ERROR');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare("SELECT search_attempts,search_successes,search_failures FROM private_usage_summary WHERE provider='searxng'").get())
      .toMatchObject({ search_attempts: 2, search_successes: 1, search_failures: 1 });
  });
  it('does not make an unreserved recovery call when the daily allowance is exhausted', async () => {
    configureSearxng(); enableRelay(); env.SEARXNG_ENGINES = 'google,bing'; env.DAILY_SERP_LIMIT = 1;
    fetch.mockImplementation(async () => Response.json({ results: [{ title: 'Initial', url: 'https://publisher.example/initial', engine: 'bing' }] }));
    const response = await api('/api/search', 'POST', relayBody);
    expect(response.status).toBe(200);
    expect(response.data.results).toHaveLength(1);
    expect(response.data.coverage).toMatchObject({ attempts: 1, google_recovery: 'budget_skipped' });
    expect(fetch).toHaveBeenCalledOnce();
    expect(sqlite.prepare("SELECT search_attempts FROM private_usage_summary WHERE provider='searxng'").get().search_attempts).toBe(1);
  });
  it('does not retry an explicitly unresponsive Google engine', async () => {
    configureSearxng(); enableRelay(); env.SEARXNG_ENGINES = 'google,bing';
    fetch.mockImplementation(async () => Response.json({ results: [{ title: 'Initial', url: 'https://publisher.example/initial', engine: 'bing' }],
      unresponsive_engines: [['google', 'CAPTCHA']] }));
    const response = await api('/api/search', 'POST', relayBody);
    expect(response.status).toBe(200); expect(response.data.partial).toBe(true);
    expect(response.data.coverage).not.toHaveProperty('google_recovery');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('counts each second-page search against the existing allowance',async()=>{
    configureSearxng();enableRelay();env.DAILY_SERP_LIMIT=1;
    fetch.mockImplementation(async()=>Response.json({results:[]},{headers:{'Content-Type':'application/json'}}));
    expect((await api('/api/search','POST',{...relayBody,page:2})).status).toBe(200);
    expect(new URLSearchParams(fetch.mock.calls[0][1].body).get('pageno')).toBe('2');
    expect((await api('/api/search','POST',{...relayBody,page:2})).status).toBe(429);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([null,0,4,1.2,'2'])('rejects invalid search page %s before database or network access',async page=>{
    configureSearxng();enableRelay();poisonDatabase();
    expect((await api('/api/search','POST',{...relayBody,page})).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reports honest capabilities without exposing instance configuration', async () => {
    configureSearxng(); poisonDatabase();
    const result = await api('/api/config');
    expect(result.data).toMatchObject({ provider: 'searxng', demo: false, cloud_ai_enabled: false,
      search_relay_enabled: false, search_country_supported: false, autocomplete_supported: false, search_engines: ['google cse'] });
    expect(JSON.stringify(result.data)).not.toMatch(/search\.example|synthetic-instance-token|SEARXNG_URL|SEARXNG_TOKEN/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('exposes only valid configured engine labels while leaving malformed configuration private', async () => {
    configureSearxng(); poisonDatabase();
    env.SEARXNG_ENGINES = 'Google CSE, Brave,google cse';
    expect((await api('/api/config')).data.search_engines).toEqual(['google cse', 'brave']);
    env.SEARXNG_ENGINES = 'private-instance-token';
    const response = await api('/api/config');
    expect(response.status).toBe(200);
    expect(response.data.search_engines).toEqual([]);
    expect(JSON.stringify(response.data)).not.toMatch(/private-instance-token|search\.example|synthetic-instance-token/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves bounded adapter coverage and allowlisted actual engines past the old twenty-result cap', async () => {
    configureSearxng(); enableRelay();
    const results = Array.from({ length: SEARCH_RESULT_LIMIT + 4 }, (_, i) => ({
      title: `Example Person result ${i}`, url: `https://publisher.example/story/${i}`, content: 'A text result.',
      engine: i % 2 ? 'brave' : 'google cse', engines: ['google cse', 'private-instance-token', 'https://search.example/'] }));
    results.splice(22, 0, { url: 'http://localhost/private', engine: 'private-instance-token' });
    fetch.mockResolvedValue(Response.json({ results, coverage: { returned: 0, secret: 'private-instance-token' },
      unresponsive_engines: [['unknown', 'private error detail']] }, { headers: { 'Content-Type': 'application/json' } }));
    const response = await api('/api/search', 'POST', relayBody);
    expect(response.status).toBe(200);
    expect(response.data.results).toHaveLength(SEARCH_RESULT_LIMIT);
    expect(response.data.results.some(item => item.url === 'https://publisher.example/story/25')).toBe(true);
    expect(response.data.coverage).toEqual({ returned: 105, invalid: 1, limited: 4, engines: ['google cse', 'brave'] });
    expect(response.data.partial).toBe(true);
    expect(JSON.stringify(response.data)).not.toMatch(/private-instance-token|search\.example|private error|unknown|localhost/);
    expect(Object.keys(response.data.results[0]).sort()).toEqual(['snippet', 'title', 'url']);
    expect(JSON.stringify(statements)).not.toMatch(/Example Person|publisher\.example|private-instance-token/);
    assertNoLegacyContent();
  });
  it('keeps the disabled relay ahead of body parsing, database access and outbound calls', async () => {
    configureSearxng(); poisonDatabase();
    const request = new Request('https://scanner.example/api/search', { method: 'POST', body: 'private unparsed payload' });
    expect((await worker.fetch(request, env)).status).toBe(403);
    expect(request.bodyUsed).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends only the query to the fixed instance, preserves partial status, and stores no query or result content', async () => {
    configureSearxng(); enableRelay();
    const log = vi.spyOn(console, 'log'), warn = vi.spyOn(console, 'warn'), error = vi.spyOn(console, 'error');
    try {
      fetch.mockResolvedValue(Response.json({ results: [{ title: '<b>Example Person</b>', url: 'https://publisher.example/story', content: 'Bounded text', img_src: 'https://media.example/private.jpg' }],
        unresponsive_engines: [['google cse', 'sensitive error detail']] }, { headers: { 'Content-Type': 'application/json' } }));
      const response = await api('/api/search', 'POST', { ...relayBody, country_code: 'sg' });
      expect(response.status).toBe(200);
      expect(response.data).toEqual({ results: [{ title: 'Example Person', url: 'https://publisher.example/story', snippet: 'Bounded text' }], related: [],
        coverage: { returned: 1, invalid: 0, limited: 0, engines: [] }, partial: true });
      const [url, options] = fetch.mock.calls[0];
      expect(url.href).toBe('https://search.example/search');
      expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({ q: relayBody.q, format: 'json', language: 'all', safesearch: '0', engines: 'google cse' });
      expect(options.headers.Authorization).toBe('Bearer synthetic-instance-token');
      expect(fetch).toHaveBeenCalledOnce();
      expect(sqlite.prepare('SELECT search_attempts AS search_count, estimated_search_cost_usd AS cost_usd FROM private_usage_summary').get()).toMatchObject({ search_count: 1, cost_usd: 0.001 });
      expect(statements.every(statement => /search_permits|private_usage_summary/.test(statement.sql))).toBe(true);
      expect(JSON.stringify(statements)).not.toMatch(/Example Person|publisher\.example|synthetic-instance-token|sensitive/);
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM assistance_requests').get().n).toBe(0);
      assertNoLegacyContent();
      expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); warn.mockRestore(); error.mockRestore(); }
  });
  it('returns no autocomplete without accessing the database or sending a query', async () => {
    configureSearxng(); enableRelay(); poisonDatabase();
    expect((await api('/api/search', 'POST', { ...relayBody, kind: 'autocomplete' })).data).toEqual({ suggestions: [] });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails incomplete empty searches with a safe error while counting the attempted call', async () => {
    configureSearxng(); enableRelay();
    fetch.mockResolvedValue(Response.json({ results: [], unresponsive_engines: [['google cse', 'Example Person synthetic-instance-token raw error']] }, { headers: { 'Content-Type': 'application/json' } }));
    const response = await api('/api/search', 'POST', relayBody);
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.data)).not.toMatch(/Example Person|synthetic-instance-token|raw error|google cse/);
    expect(sqlite.prepare('SELECT search_attempts AS search_count FROM private_usage_summary').get().search_count).toBe(1);
    expect(JSON.stringify(statements)).not.toContain(relayBody.q);
    assertNoLegacyContent();
  });
  it('rejects missing instance authentication before reservations or network calls', async () => {
    configureSearxng(); enableRelay(); poisonDatabase();
    delete env.SEARXNG_TOKEN;
    expect((await api('/api/search', 'POST', relayBody)).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ engines: 'other' }, { endpoint: 'https://attacker.example/' }, { token: 'client supplied' }])('rejects client overrides of operator-only settings: %j', async fields => {
    configureSearxng(); enableRelay(); poisonDatabase();
    expect((await api('/api/search', 'POST', { ...relayBody, ...fields })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('explicit assistance submission', () => {
  it.each([undefined, false, 'true', 1])('rejects consent %s without database access', async consent => {
    poisonDatabase();
    expect((await api('/api/assistance', 'POST', { ...assistanceBody, consent })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { attachment: sharedReport }, { share_report: false, attachment: sharedReport }, { share_report: 'true', attachment: sharedReport },
    { share_report: true }, { scan_id: 'local-id' }, { hit_ids: [1] }, { consent_version: 'spoofed' },
    { email: 'invalid' }, { name: 'x'.repeat(81) }, { message: 'x'.repeat(3001) }, { help_type: 'unknown' },
  ])('rejects unconsented attachments or unexpected fields: %j', async patch => {
    poisonDatabase();
    expect((await api('/api/assistance', 'POST', { ...assistanceBody, ...patch })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('saves a contact-only request when email delivery is not configured, with no report, scan association, or outbound message', async () => {
    const result = await api('/api/assistance', 'POST', assistanceBody);
    expect(result.status).toBe(201);
    expect(result.data).toEqual({ ok: true, delivered: false, request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      message: 'Your request was received and saved for the 123 Reputation Management team to review. We will reply to the email address you gave. Partner organisations are contacted only with your agreement.' });
    const stored = sqlite.prepare('SELECT * FROM assistance_requests').get();
    expect(stored).toMatchObject({ id: result.data.request_id, name: assistanceBody.name, email: assistanceBody.email, message: assistanceBody.message, attachment_json: null, links_json: null, consent_version: 'assistance-v2', delivered: 0 });
    expect(stored.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(statements).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
    assertNoLegacyContent();
  });
  it('saves only the explicitly selected allowlisted report attachment', async () => {
    expect((await api('/api/assistance', 'POST', { ...assistanceBody, share_report: true, attachment: sharedReport })).status).toBe(201);
    const stored = sqlite.prepare('SELECT attachment_json FROM assistance_requests').get();
    expect(JSON.parse(stored.attachment_json)).toEqual(sharedReport);
    expect(fetch).not.toHaveBeenCalled();
    assertNoLegacyContent();
  });
  it.each([
    { ...sharedReport, context: { full_scan: true } },
    { ...sharedReport, subject_type: 'other' },
    { ...sharedReport, results: Array.from({ length: 21 }, () => sharedReport.results[0]) },
    { ...sharedReport, results: [{ ...sharedReport.results[0], snippet: 'Unselected result body' }] },
    ...['javascript:alert(1)', 'https://user:pass@publisher.example/', 'http://localhost/private', 'http://192.168.1.1/', 'http://[::1]/'].map(url => ({ ...sharedReport, results: [{ url, title: 'Unsafe URL' }] })),
  ])('rejects unexpected report data and unsafe links before persistence: %j', async attachment => {
    poisonDatabase();
    expect((await api('/api/assistance', 'POST', { ...assistanceBody, share_report: true, attachment })).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('assistance email delivery', () => {
  const mailEnv = (send = vi.fn(async () => {})) => {
    env.ASSISTANCE_MAIL = { send };
    env.ASSISTANCE_TO = 'owner@inbox.example';
    env.ASSISTANCE_FROM = 'scanner@123reputationmanagement.org';
    return send;
  };
  const decodeBody = raw => new TextDecoder().decode(Uint8Array.from(atob(raw.split('\r\n\r\n')[1].replace(/\r\n/g, '')), c => c.charCodeAt(0)));
  const headerBlock = raw => raw.split('\r\n\r\n')[0];

  it('emails the request with every submitted detail and keeps only a content-free receipt', async () => {
    const send = mailEnv();
    const links = ['https://t.me/+PrivateInviteCode', 'https://publisher.example/other'];
    const result = await api('/api/assistance', 'POST', { ...assistanceBody, help_type: 'legal', links, share_report: true, attachment: sharedReport });
    expect(result.status).toBe(201);
    expect(result.data).toEqual({ ok: true, delivered: true, request_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      message: 'Your request was sent to the 123 Reputation Management team. We will reply to the email address you gave. Partner organisations are contacted only with your agreement.' });
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message).toMatchObject({ from: 'scanner@123reputationmanagement.org', to: 'owner@inbox.example' });
    const headers = headerBlock(message.raw);
    expect(headers).toContain('From: "Reputation Scanner" <scanner@123reputationmanagement.org>');
    expect(headers).toContain('To: <owner@inbox.example>');
    expect(headers).toContain('Reply-To: "Example Reporter" <reporter@example.test>');
    expect(headers).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(headers).toContain('MIME-Version: 1.0');
    expect(headers).toContain(`Message-ID: <${result.data.request_id}@123reputationmanagement.org>`);
    const body = decodeBody(message.raw);
    for (const expected of ['Help type: Legal advice from a qualified professional', 'Name: Example Reporter', 'Reply-to email: reporter@example.test',
      assistanceBody.message, 'https://t.me/+PrivateInviteCode', 'https://publisher.example/other', 'https://publisher.example/story?content=exact#item',
      `Request ID: ${result.data.request_id}`, 'Submitted: 20']) expect(body).toContain(expected);
    const stored = sqlite.prepare('SELECT * FROM assistance_requests').all();
    expect(stored).toEqual([expect.objectContaining({ id: result.data.request_id, help_type: 'legal', delivered: 1, name: '', email: '', message: '', attachment_json: null, links_json: null })]);
    expect(JSON.stringify(stored)).not.toContain('reporter@example.test');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the full request in D1 when the send fails', async () => {
    const send = mailEnv(vi.fn(async () => { throw new Error('destination address not verified'); }));
    const result = await api('/api/assistance', 'POST', { ...assistanceBody, links: ['https://t.me/joinchat/Example'] });
    expect(result.status).toBe(201);
    expect(result.data).toMatchObject({ ok: true, delivered: false });
    expect(result.data.message).toContain('received');
    expect(send).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT * FROM assistance_requests').get()).toMatchObject({ name: assistanceBody.name, email: assistanceBody.email,
      message: assistanceBody.message, links_json: JSON.stringify(['https://t.me/joinchat/Example']), delivered: 0 });
  });

  it.each([
    ['incomplete configuration', () => { mailEnv(); delete env.ASSISTANCE_TO; }],
    ['an unsafe configured address', () => { mailEnv(); env.ASSISTANCE_FROM = 'scanner@example.org\r\nBcc: x@evil.example'; }],
  ])('stores the request instead of sending with %s', async (_label, configure) => {
    configure();
    const result = await api('/api/assistance', 'POST', assistanceBody);
    expect(result.data.delivered).toBe(false);
    expect(env.ASSISTANCE_MAIL.send).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT delivered FROM assistance_requests').get().delivered).toBe(0);
  });

  it('cannot inject headers through the name, message, links or email', async () => {
    const send = mailEnv();
    const result = await api('/api/assistance', 'POST', { ...assistanceBody,
      name: 'Eve\r\nBcc: victim@evil.example\nX-Injected: 1',
      message: 'Hello\r\n\r\nSubject: spoofed\r\nBcc: victim@evil.example',
      email: 'attacker>,Bcc:hidden@evil.example' });
    expect(result.status).toBe(201);
    const raw = send.mock.calls[0][0].raw, headers = headerBlock(raw);
    const lines = headers.split('\r\n').filter(line => !line.startsWith(' '));
    expect(lines.map(line => line.split(':')[0])).toEqual(['From', 'To', 'Subject', 'Date', 'Message-ID', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding', 'Auto-Submitted']);
    expect(headers).not.toMatch(/^(Bcc|X-Injected|Reply-To):/im);
    expect(headers).not.toContain('hidden@evil.example');
    expect(headers).toMatch(/^Subject: Reputation Scanner assistance: Not sure yet from Eve Bcc: victim@evil\.example X-Injected: 1$/m);
    expect(raw.split('\r\n\r\n')[1]).toMatch(/^[A-Za-z0-9+/=\r\n]+$/);
    expect(decodeBody(raw)).toContain('not used as Reply-To');
    // Newlines in the name are folded into a single safe header value.
    const nameOnly = await api('/api/assistance', 'POST', { ...assistanceBody, name: 'Eve\r\nBcc: victim@evil.example' });
    expect(nameOnly.status).toBe(201);
    const second = headerBlock(send.mock.calls[1][0].raw);
    expect(second).not.toMatch(/^Bcc:/im);
    expect(second).toContain('Reply-To: "Eve Bcc: victim@evil.example" <reporter@example.test>');
  });

  it('encodes non-ASCII names and subjects as UTF-8 encoded-words', async () => {
    const send = mailEnv();
    expect((await api('/api/assistance', 'POST', { ...assistanceBody, name: '陈美玲 Zoë', message: 'Café 裸 ✓' })).status).toBe(201);
    const raw = send.mock.calls[0][0].raw, headers = headerBlock(raw);
    expect(headers).toMatch(/^[\x20-\x7e\r\n]+$/);
    expect(headers).toMatch(/Reply-To: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
    expect(decodeBody(raw)).toContain('Café 裸 ✓');
    expect(decodeBody(raw)).toContain('陈美玲 Zoë');
  });

  it.each([
    [{ links: 'https://t.me/x' }], [{ links: Array.from({ length: 21 }, (_, i) => `https://t.me/${i}`) }],
    [{ links: ['javascript:alert(1)'] }], [{ links: ['https://user:pass@t.me/x'] }], [{ links: [42] }],
  ])('rejects invalid shared links before any send or storage: %j', async patch => {
    const send = mailEnv();
    poisonDatabase();
    expect((await api('/api/assistance', 'POST', { ...assistanceBody, ...patch })).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('domain-only reporting lookup boundary', () => {
  it('rejects page URLs, private hosts, extra personal data and missing Origin before outbound lookup', async () => {
    const headers = { Origin: 'https://scanner.example' };
    for (const body of [{ hostname: 'https://publicsite.com/private' }, { hostname: '127.0.0.1' }, { hostname: 'publicsite.com', name: 'Private name' }]) {
      expect((await api('/api/reporting-contact', 'POST', body, headers)).status).toBe(400);
    }
    expect((await api('/api/reporting-contact', 'POST', { hostname: 'publicsite.com' })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('returns explicit investigation status when public registry services are unavailable', async () => {
    fetch.mockResolvedValue(new Response('', { status: 503 }));
    const result = await api('/api/reporting-contact', 'POST', { hostname: 'publicsite.com' }, { Origin: 'https://scanner.example' });
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ hostname: 'publicsite.com', status: 'needs_investigation', contacts: [] });
    expect(fetch.mock.calls.some(([url]) => new URL(url).hostname === 'publicsite.com')).toBe(false);
    assertNoLegacyContent();
  });
});
