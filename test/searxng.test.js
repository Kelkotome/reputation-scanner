import { afterEach, describe, expect, it, vi } from 'vitest';
import { search, autocomplete } from '../src/serp.js';
import { searchSearxng, validateSearxngConfiguration, configuredSearxngEngines, SEARXNG_MAX_BYTES } from '../src/searxng.js';
import { SEARCH_RESULT_LIMIT, safeSearchEngines } from '../src/search-limits.js';

const env = { SERP_PROVIDER: 'searxng', SEARXNG_URL: 'https://search.example/private/',
  SEARXNG_TOKEN: 'synthetic-test-token', SEARXNG_ENGINES: 'google cse' };
const accessEnv = { ...env, SEARXNG_TOKEN: '', SEARXNG_ACCESS_CLIENT_ID: 'synthetic-client.access',
  SEARXNG_ACCESS_CLIENT_SECRET: `cfast_${'A'.repeat(48)}` };
const result = { title: '<b>Example</b> title', url: 'https://publisher.example/story?ref=exact#item',
  content: 'A <em>text</em> result.', engine: 'google cse', thumbnail: 'https://media.example/private.jpg' };
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
afterEach(() => vi.useRealTimers());

describe('SearXNG query-only provider', () => {
  it('requests a bounded second page while keeping media out of the response', async () => {
    const fetchImpl=vi.fn(async()=>json({results:[result]}));
    const output=await search(env,'Example Person',fetchImpl,{page:2});
    expect(new URLSearchParams(fetchImpl.mock.calls[0][1].body).get('pageno')).toBe('2');
    expect(output.results[0]).not.toHaveProperty('thumbnail');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it.each([null,0,-1,4,1.5,'2'])('rejects unsupported page %s before a provider request',async page=>{
    const fetchImpl=vi.fn();
    await expect(searchSearxng(env,'Example',fetchImpl,{page})).rejects.toThrow('searxng_page');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('supports an HTTPS X-Proxy-Key gateway without exposing the key in the URL, query or output', async () => {
    const input = { ...env, SEARXNG_TOKEN: '', SEARXNG_PROXY_KEY: 'synthetic-proxy-key' };
    const fetchImpl = vi.fn(async () => json({ results: [result] }));
    const output = await searchSearxng(input, 'example.com', fetchImpl);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(options.headers['X-Proxy-Key']).toBe(input.SEARXNG_PROXY_KEY);
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.redirect).toBe('manual');
    expect(JSON.stringify([url.href, options.body, output])).not.toContain(input.SEARXNG_PROXY_KEY);
    expect(output.results).toHaveLength(1);
  });
  it.each([null, 123, 'bad\r\nheader', ' padded ', 'x'.repeat(1025)])('rejects an invalid proxy key before network access: %j', async key => {
    const fetchImpl = vi.fn();
    await expect(searchSearxng({ ...env, SEARXNG_PROXY_KEY: key }, 'example.com', fetchImpl)).rejects.toThrow('searxng_configuration');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('never sends a proxy key over HTTP, including loopback', async () => {
    const fetchImpl = vi.fn();
    await expect(searchSearxng({ ...env, SEARXNG_URL: 'http://127.0.0.1:8890', SEARXNG_ALLOW_LOOPBACK_HTTP: 'true', SEARXNG_PROXY_KEY: 'synthetic-key' }, 'example.com', fetchImpl)).rejects.toThrow('searxng_configuration');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('uses a fixed authenticated POST without URL query data, country routing, or media fields', async () => {
    const fetchImpl = vi.fn(async () => json({ results: [result], unresponsive_engines: [],
      answers: ['not exposed'], suggestions: ['not exposed'], private_metadata: 'not exposed' }));
    const output = await search({ ...env, SERP_GL: 'sg' }, '"Example Person" complaint', fetchImpl);
    expect(output).toEqual({ results: [{ title: 'Example title', url: result.url, snippet: 'A text result.' }], related: [],
      coverage: { returned: 1, invalid: 0, limited: 0, engines: ['google cse'] } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url.href).toBe('https://search.example/private/search');
    expect(options).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Authorization: 'Bearer synthetic-test-token', 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' } });
    expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({ q: '"Example Person" complaint', format: 'json', language: 'all', safesearch: '0', engines: 'google cse' });
    expect(Object.keys(options.headers).sort()).toEqual(['Accept', 'Authorization', 'Content-Type']);
  });
  it.each([1, 2, 3])('keeps multilingual web coverage on page %s without widening engines or exposing credentials/media', async page => {
    const input = { ...env, SEARXNG_ENGINES: 'google,duckduckgo,google cse',
      SEARXNG_PROXY_KEY: 'synthetic-proxy-key' };
    const foreignResult = { ...result, engine: 'google', title: '<b>OpenStreetMap</b> · mapa del mundo',
      content: 'Explora un mapa de España y otros países.', url: 'https://publisher.example/mapa' };
    const fetchImpl = vi.fn(async () => json({ results: [foreignResult],
      language: 'es', private_metadata: 'not exposed' }));
    const output = await searchSearxng(input, 'OpenStreetMap mapa', fetchImpl, { page });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({
      q: 'OpenStreetMap mapa', format: 'json', language: 'all', safesearch: '0',
      engines: 'google,duckduckgo,google cse', ...(page > 1 ? { pageno: String(page) } : {}),
    });
    expect(options.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${input.SEARXNG_TOKEN}`, 'X-Proxy-Key': input.SEARXNG_PROXY_KEY });
    expect(url.href).toBe('https://search.example/private/search');
    expect(output).toEqual({ results: [{ title: 'OpenStreetMap · mapa del mundo',
      url: foreignResult.url, snippet: foreignResult.content }], related: [],
      coverage: { returned: 1, invalid: 0, limited: 0, engines: ['google'] } });
    const publicData = JSON.stringify([url.href, options.body, output]);
    expect(publicData).not.toContain(input.SEARXNG_TOKEN);
    expect(publicData).not.toContain(input.SEARXNG_PROXY_KEY);
    expect(publicData).not.toMatch(/thumbnail|media\.example|private_metadata/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('never calls autocomplete or another provider even when legacy credentials are configured', async () => {
    const fetchImpl = vi.fn();
    expect(await autocomplete({ ...env, SERP_API_KEY: 'unused', ANTHROPIC_API_KEY: 'unused' }, 'Example', fetchImpl)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['a'.repeat(64), `cfast_${'B'.repeat(48)}`])('supports an Access token pair without bearer authentication: %s', async secret => {
    const fetchImpl = vi.fn(async () => json({ results: [] }));
    const input = { ...accessEnv, SEARXNG_ACCESS_CLIENT_SECRET: secret };
    expect(() => validateSearxngConfiguration(input)).not.toThrow();
    await expect(searchSearxng(input, 'Example', fetchImpl)).resolves.toEqual({ results: [], related: [], coverage: { returned: 0, invalid: 0, limited: 0, engines: [] } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url.href).toBe('https://search.example/private/search');
    expect(options.headers).toEqual({ Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded',
      'CF-Access-Client-Id': input.SEARXNG_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': secret });
    expect(options).toMatchObject({ redirect: 'manual', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    expect(options.body).not.toContain(secret);
    expect(options.body).not.toContain(input.SEARXNG_ACCESS_CLIENT_ID);
  });
  it('sends both bearer and Access credentials when both are configured', async () => {
    const fetchImpl = vi.fn(async () => json({ results: [] }));
    await searchSearxng({ ...accessEnv, SEARXNG_TOKEN: env.SEARXNG_TOKEN }, 'Example', fetchImpl);
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({ Authorization: `Bearer ${env.SEARXNG_TOKEN}`,
      'CF-Access-Client-Id': accessEnv.SEARXNG_ACCESS_CLIENT_ID,
      'CF-Access-Client-Secret': accessEnv.SEARXNG_ACCESS_CLIENT_SECRET });
  });
  it('preserves bearer-only configuration when both Access settings are empty', async () => {
    const fetchImpl = vi.fn(async () => json({ results: [] }));
    await searchSearxng({ ...env, SEARXNG_ACCESS_CLIENT_ID: '', SEARXNG_ACCESS_CLIENT_SECRET: '' }, 'Example', fetchImpl);
    expect(Object.keys(fetchImpl.mock.calls[0][1].headers).sort()).toEqual(['Accept', 'Authorization', 'Content-Type']);
  });
  it.each([
    { SEARXNG_ACCESS_CLIENT_ID: undefined }, { SEARXNG_ACCESS_CLIENT_SECRET: undefined },
    { SEARXNG_ACCESS_CLIENT_ID: '' }, { SEARXNG_ACCESS_CLIENT_SECRET: '' },
    { SEARXNG_ACCESS_CLIENT_ID: null }, { SEARXNG_ACCESS_CLIENT_SECRET: 123 },
    { SEARXNG_ACCESS_CLIENT_ID: 'bad:client' }, { SEARXNG_ACCESS_CLIENT_SECRET: 'bad:secret' },
    { SEARXNG_ACCESS_CLIENT_ID: 'has space' }, { SEARXNG_ACCESS_CLIENT_SECRET: ' has-padding ' },
    { SEARXNG_ACCESS_CLIENT_ID: 'bad\n' }, { SEARXNG_ACCESS_CLIENT_SECRET: 'bad\n' },
    { SEARXNG_ACCESS_CLIENT_ID: 'bad\r\nheader' }, { SEARXNG_ACCESS_CLIENT_SECRET: 'bad\u0000secret' },
    { SEARXNG_ACCESS_CLIENT_ID: 'bad\u007f' }, { SEARXNG_ACCESS_CLIENT_SECRET: 'bad\tsecret' },
    { SEARXNG_ACCESS_CLIENT_ID: 'non-ascii-é' }, { SEARXNG_ACCESS_CLIENT_SECRET: 'non-ascii-é' },
    { SEARXNG_ACCESS_CLIENT_ID: 'i'.repeat(257) }, { SEARXNG_ACCESS_CLIENT_SECRET: 's'.repeat(1025) },
    { SEARXNG_TOKEN: null }, { SEARXNG_TOKEN: 'bad\n' }, { SEARXNG_TOKEN: 't'.repeat(1025) },
    { SEARXNG_URL: 'http://127.0.0.1:8080', SEARXNG_ALLOW_LOOPBACK_HTTP: 'true' },
  ])('rejects malformed or partial Access configuration even with a valid bearer token: %j', async patch => {
    const input = { ...accessEnv, SEARXNG_TOKEN: env.SEARXNG_TOKEN, ...patch }, fetchImpl = vi.fn();
    expect(() => validateSearxngConfiguration(input)).toThrow(/^searxng_configuration$/);
    await expect(searchSearxng(input, 'Example', fetchImpl)).rejects.toThrow(/^searxng_configuration$/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([
    { SEARXNG_URL: undefined }, { SEARXNG_URL: 'http://search.example' }, { SEARXNG_URL: 'https://user:pass@search.example' },
    { SEARXNG_URL: 'https://search.example?q=stored' }, { SEARXNG_URL: 'https://search.example/#fragment' },
    { SEARXNG_TOKEN: '' }, { SEARXNG_TOKEN: 'bad\r\nheader' }, { SEARXNG_ENGINES: '' }, { SEARXNG_ENGINES: undefined },
    { SEARXNG_ENGINES: 'google,unknown' }, { SEARXNG_ENGINES: 'google,bing,brave,startpage' },
    { SEARXNG_URL: 'http://localhost.attacker.example', SEARXNG_ALLOW_LOOPBACK_HTTP: 'true' },
    { SEARXNG_URL: 'http://192.168.1.10', SEARXNG_ALLOW_LOOPBACK_HTTP: 'true' },
    { SEARXNG_URL: 'http://127.0.0.1', SEARXNG_ALLOW_LOOPBACK_HTTP: true },
  ])('rejects invalid instance configuration without a network call: %j', async patch => {
    const fetchImpl = vi.fn();
    await expect(searchSearxng({ ...env, ...patch }, 'Example', fetchImpl)).rejects.toThrow(/^searxng_configuration$/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['http://127.0.0.1:8080/', 'http://localhost:8080/search', 'http://[::1]:8080/'])('permits explicit tokenless loopback development only: %s', async url => {
    const fetchImpl = vi.fn(async () => json({ results: [] }));
    await expect(searchSearxng({ ...env, SEARXNG_URL: url, SEARXNG_TOKEN: '', SEARXNG_ALLOW_LOOPBACK_HTTP: 'true' }, 'Example', fetchImpl)).resolves.toEqual({ results: [], related: [], coverage: { returned: 0, invalid: 0, limited: 0, engines: [] } });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it.each(['', 'x'.repeat(501), 'Example !google', '!!g Example', 'Example\nsecret', null])('rejects query-control syntax or invalid queries before sending: %j', async query => {
    const fetchImpl = vi.fn();
    await expect(searchSearxng(env, query, fetchImpl)).rejects.toThrow(/^searxng_query$/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('bounds metadata and drops invalid, private or credential-bearing links', async () => {
    const invalid = ['javascript:alert(1)', 'https://user:secret@publisher.example/', 'http://127.1/', 'http://[::1]/', 'http://10.0.0.1/', 'http://host.internal/', 'http://localhost/', 'https://publisher.example/\nsecret'];
    const fetchImpl = vi.fn(async () => json({ results: [...invalid.map(url => ({ ...result, url })),
      ...Array.from({ length: 30 }, (_, i) => ({ ...result, title: 't'.repeat(700), content: 'c'.repeat(2500), url: `https://publisher.example/${i}` }))] }));
    const output = await searchSearxng(env, 'Example', fetchImpl);
    expect(output.results).toHaveLength(30);
    expect(output.results[0]).toEqual({ title: 't'.repeat(500), url: 'https://publisher.example/0', snippet: 'c'.repeat(2000) });
    expect(output.results.every(item => Object.keys(item).sort().join(',') === 'snippet,title,url')).toBe(true);
    expect(output.coverage).toEqual({ returned: 38, invalid: 8, limited: 0, engines: ['google cse'] });
  });
  it('keeps results after position twenty and reports the bounded page cap without exposing extra metadata', async () => {
    const entries = Array.from({ length: SEARCH_RESULT_LIMIT + 10 }, (_, i) => ({ ...result,
      title: `Example result ${i}`, url: `https://publisher.example/story/${i}`, engine: i % 2 ? 'brave' : 'google cse',
      engines: ['google cse', 'private-instance-token', 'https://search.example/private', 'unknown'] }));
    entries.splice(21, 0, { ...result, url: 'javascript:private-token' });
    const output = await searchSearxng(env, 'Example', async () => json({ results: entries, coverage: { secret: 'private-instance-token' } }));
    expect(output.results).toHaveLength(SEARCH_RESULT_LIMIT);
    expect(output.results.some(item => item.url === 'https://publisher.example/story/25')).toBe(true);
    expect(output.coverage).toEqual({ returned: 111, invalid: 1, limited: 10, engines: ['google cse', 'brave'] });
    expect(JSON.stringify(output)).not.toMatch(/private-instance-token|search\.example|unknown|thumbnail|javascript/);
  });
  it('exposes only safe configured and actual engine labels with fixed keys', async () => {
    expect(configuredSearxngEngines({ ...env, SEARXNG_ENGINES: ' Google CSE,Brave,google cse' })).toEqual(['google cse', 'brave']);
    expect(configuredSearxngEngines({ ...env, SEARXNG_TOKEN: '' })).toEqual([]);
    expect(configuredSearxngEngines({ ...env, SEARXNG_ENGINES: 'private-token' })).toEqual([]);
    expect(safeSearchEngines([' GOOGLE ', 'google', null, 42, 'google cse', 'google-private-token', 'https://search.example/', 'images'])).toEqual(['google', 'google cse']);
    expect(safeSearchEngines('google')).toEqual([]);
    const output = await searchSearxng(env, 'Example', async () => json({ results: [{ ...result,
      engine: 'private-token', engines: ['Bing', 'bing', 'google-private-token', null] }] }));
    expect(output.coverage).toEqual({ returned: 1, invalid: 0, limited: 0, engines: ['bing'] });
    expect(Object.keys(output.coverage).sort()).toEqual(['engines', 'invalid', 'limited', 'returned']);
  });
  it('marks partial results without exposing engine errors or provider metadata', async () => {
    const output = await searchSearxng(env, 'Example', async () => json({ results: [result], unresponsive_engines: [['google', 'private raw error and query']] }));
    expect(output).toEqual({ results: [{ title: 'Example title', url: result.url, snippet: 'A text result.' }], related: [],
      coverage: { returned: 1, invalid: 0, limited: 0, engines: ['google cse'] }, partial: true });
  });
  it('does not attribute unusable URLs to a functioning engine', async () => {
    const output = await searchSearxng(env, 'Example', async () => json({ results: [
      { ...result, url: 'javascript:private-token', engine: 'google', engines: ['brave'] },
      { ...result, url: 'http://localhost/private', engine: 'google' },
      result,
    ] }));
    expect(output.coverage).toEqual({ returned: 3, invalid: 2, limited: 0, engines: ['google cse'] });
  });
  it.each([{ results: [] }, { results: [{ ...result, url: 'javascript:bad' }] }])('does not turn engine failure with no usable results into a clean search', async ({ results }) => {
    await expect(searchSearxng(env, 'Example', async () => json({ results, unresponsive_engines: [['google', 'raw error']] }))).rejects.toThrow(/^searxng_engines_unavailable$/);
  });
  it.each([
    [{ error: 'private query and token', results: [] }, 'response_error'],
    [{ errors: ['private query and token'], results: [] }, 'response_error'],
    [{ results: null }, 'response_format'], [{ results: [], unresponsive_engines: 'private error' }, 'response_format'],
  ])('sanitizes malformed or unsuccessful JSON responses', async (body, code) => {
    await expect(searchSearxng(env, 'Example', async () => json(body))).rejects.toThrow(new RegExp(`^searxng_${code}$`));
  });
  it('sanitizes HTTP errors and connection errors without falling back', async () => {
    const failedHttp = vi.fn(async () => new Response('private provider payload', { status: 403 }));
    await expect(searchSearxng(env, 'Example', failedHttp)).rejects.toThrow(/^searxng_http_403$/);
    expect(failedHttp).toHaveBeenCalledOnce();
    const failedFetch = vi.fn(async () => { throw new Error('private query https://search.example synthetic-test-token'); });
    await expect(searchSearxng(env, 'Example', failedFetch)).rejects.toThrow(/^searxng_request_failed$/);
    expect(failedFetch).toHaveBeenCalledOnce();
  });
  it.each([env, accessEnv, { ...accessEnv, SEARXNG_TOKEN: env.SEARXNG_TOKEN }])('rejects redirects without forwarding the query or credentials to the Location endpoint', async input => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn(async () => new Response(new ReadableStream({ cancel }), {
      status: 302, headers: { Location: 'https://untrusted.example/query?token=synthetic-private-token' },
    }));
    await expect(searchSearxng(input, 'Example', fetchImpl)).rejects.toThrow(/^searxng_http_302$/);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0].origin).toBe('https://search.example');
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('sanitizes Access errors without exposing either credential or response payload', async () => {
    const raw = `${accessEnv.SEARXNG_ACCESS_CLIENT_ID} ${accessEnv.SEARXNG_ACCESS_CLIENT_SECRET}`;
    const failedFetch = vi.fn(async () => { throw new Error(raw); });
    await expect(searchSearxng(accessEnv, 'Example', failedFetch)).rejects.toThrow(/^searxng_request_failed$/);
    expect(failedFetch).toHaveBeenCalledOnce();
    const denied = vi.fn(async () => new Response(raw, { status: 403 }));
    await expect(searchSearxng(accessEnv, 'Example', denied)).rejects.toThrow(/^searxng_http_403$/);
    expect(denied).toHaveBeenCalledOnce();
  });
  it('rejects non-JSON and invalid UTF-8 without reflecting the body', async () => {
    await expect(searchSearxng(env, 'Example', async () => new Response('<html>private</html>'))).rejects.toThrow(/^searxng_response_format$/);
    await expect(searchSearxng(env, 'Example', async () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }))).rejects.toThrow(/^searxng_response_format$/);
  });
  it('rejects advertised oversized bodies before consuming content', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    await expect(searchSearxng(env, 'Example', async () => new Response(body, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(SEARXNG_MAX_BYTES + 1) } }))).rejects.toThrow(/^searxng_response_too_large$/);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('caps streamed response bytes, including multibyte content without Content-Length', async () => {
    const cancel = vi.fn(), chunk = new TextEncoder().encode('世'.repeat(100000));
    const body = new ReadableStream({ start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); }, cancel });
    await expect(searchSearxng(env, 'Example', async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }))).rejects.toThrow(/^searxng_response_too_large$/);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('aborts a stalled request and reports only a fixed timeout code', async () => {
    vi.useFakeTimers();
    let signal;
    const fetchImpl = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(new Error('private timeout payload')), { once: true });
    }));
    const pending = expect(searchSearxng(env, 'Example', fetchImpl)).rejects.toThrow(/^searxng_timeout$/);
    await vi.advanceTimersByTimeAsync(12000);
    await pending;
    expect(signal.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
