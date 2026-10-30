import { afterEach, describe, it, expect, vi } from 'vitest';
import { search, autocomplete, providerOf, GOOGLE_API_MAX_BYTES } from '../src/serp.js';
import { SEARCH_RESULT_LIMIT } from '../src/search-limits.js';

const googleEnv = provider => ({ SERP_PROVIDER: provider, SERP_API_KEY: 'synthetic-server-key', SERP_GL: '' });
const googleData = (provider, entries = []) => ({ [provider === 'serper' ? 'organic' : 'organic_results']: entries });
const googleHit = { title: 'Neutral example', link: 'https://publisher.example/story', snippet: 'Public text only.' };
afterEach(() => vi.useRealTimers());

describe('search provider adapters', () => {
  it('defaults to operator-import session mode without accidental network work', async () => {
    const fetchImpl = vi.fn();
    expect(providerOf({})).toBe('session');
    await expect(search({}, 'Anne Lee', fetchImpl)).rejects.toThrow('provider_session_has_no_live_search');
    expect(await autocomplete({}, 'Anne Lee ', fetchImpl)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('uses deterministic name-specific mock fixtures without network calls', async () => {
    const fetchImpl = vi.fn();
    const env = { SERP_PROVIDER: 'mock' };
    const result = await search(env, '"Anne Lee" scam', fetchImpl);
    expect(await search(env, '"Anne Lee" scam', fetchImpl)).toEqual(result);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every(x => x.title.includes('Anne Lee'))).toBe(true);
    expect(await autocomplete(env, 'Anne Lee ', fetchImpl)).toContain('Anne Lee scam');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['serper', 'serpapi', 'brave'])('refuses %s without a key before requesting', async provider => {
    const fetchImpl = vi.fn();
    await expect(search({ SERP_PROVIDER: provider }, 'Anne Lee', fetchImpl)).rejects.toThrow('no_serp_key');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('maps Serper results, related searches and questions', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ organic: [{ title: 'A', link: 'https://example.com/a' }], relatedSearches: [{ query: 'Anne Lee court' }], peopleAlsoAsk: [{ question: 'Anne Lee company?' }] }));
    expect(await search({ SERP_PROVIDER: 'serper', SERP_API_KEY: 'test-key' }, 'Anne Lee', fetchImpl))
      .toEqual({ results: [{ title: 'A', url: 'https://example.com/a', snippet: '' }], related: ['Anne Lee court', 'Anne Lee company?'],
        coverage: { returned: 1, invalid: 0, limited: 0, engines: ['google'] } });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://google.serper.dev/search');
    expect(JSON.parse(options.body)).toEqual({ q: 'Anne Lee', gl: 'sg', hl: 'en', num: 10 });
    expect(options.headers['X-API-KEY']).toBe('test-key');
  });
  it('maps SerpAPI and encodes the original query as one parameter', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ organic_results: [{ title: 'A', link: 'https://example.com/a', snippet: 'B' }], related_questions: [{ question: 'Anne Lee review?' }] }));
    expect(await search({ SERP_PROVIDER: 'serpapi', SERP_API_KEY: 'test-key' }, '"Anne Lee" & fraud', fetchImpl))
      .toEqual({ results: [{ title: 'A', url: 'https://example.com/a', snippet: 'B' }], related: ['Anne Lee review?'],
        coverage: { returned: 1, invalid: 0, limited: 0, engines: ['google'] } });
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('q')).toBe('"Anne Lee" & fraud');
  });
  it.each([
    { error: 'Provider response contains dummy-secret-key and private-query-marker' },
    { search_metadata: { status: 'Error' }, organic_results: [{ title: 'Partial result', link: 'https://example.com/partial' }] },
  ])('rejects a SerpAPI JSON error even with HTTP 200 using a fixed safe error (%j)', async data => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(data));
    await expect(search({ SERP_PROVIDER: 'serpapi', SERP_API_KEY: 'dummy-secret-key' }, 'private-query-marker', fetchImpl))
      .rejects.toThrow(/^serpapi_response_error$/);
  });
  it('maps successful SerpAPI autocomplete using the configured country and intact prefix', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ suggestions: [{ value: 'Anne Lee & company review' }, { value: 'Anne Lee complaint' }] }));
    expect(await autocomplete({ SERP_PROVIDER: 'serpapi', SERP_API_KEY: 'test-key', SERP_GL: 'my' }, 'Anne Lee & company ', fetchImpl))
      .toEqual(['Anne Lee & company review', 'Anne Lee complaint']);
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://serpapi.com/search.json');
    expect(Object.fromEntries(url.searchParams)).toEqual({ engine: 'google_autocomplete', q: 'Anne Lee & company ', gl: 'my', api_key: 'test-key' });
  });
  it.each(['serper', 'serpapi', 'brave'])('omits the geography parameter for explicit no-preference %s search', async provider => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    await search({ SERP_PROVIDER: provider, SERP_API_KEY: 'test-key', SERP_GL: '' }, 'Anne Lee', fetchImpl);
    const [url, options] = fetchImpl.mock.calls[0];
    const parameters = provider === 'serper' ? JSON.parse(options.body) : Object.fromEntries(new URL(url).searchParams);
    expect(parameters).not.toHaveProperty('gl');
    expect(parameters).not.toHaveProperty('country');
  });
  it.each(['serper', 'serpapi'])('omits gl for explicit no-preference %s autocomplete', async provider => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    await autocomplete({ SERP_PROVIDER: provider, SERP_API_KEY: 'test-key', SERP_GL: '' }, 'Anne Lee ', fetchImpl);
    const [url, options] = fetchImpl.mock.calls[0];
    const parameters = provider === 'serper' ? JSON.parse(options.body) : Object.fromEntries(new URL(url).searchParams);
    expect(parameters).not.toHaveProperty('gl');
  });
  it('maps Google UK geography to Brave GB', async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    await search({ SERP_PROVIDER: 'brave', SERP_API_KEY: 'test-key', SERP_GL: 'uk' }, 'Anne Lee', fetchImpl);
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('country')).toBe('GB');
  });
  it('maps Brave results and removes description markup', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ web: { results: [{ title: 'A', url: 'https://example.com/a', description: '<b>Anne Lee</b> complaint' }] }, query: { related: ['Anne Lee court'] } }));
    expect(await search({ SERP_PROVIDER: 'brave', SERP_API_KEY: 'test-key' }, 'Anne Lee', fetchImpl))
      .toEqual({ results: [{ title: 'A', url: 'https://example.com/a', snippet: 'Anne Lee complaint' }], related: ['Anne Lee court'] });
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('country')).toBe('SG');
  });
  it.each(['serper', 'serpapi', 'brave'])('propagates %s failures for pipeline retries', async provider => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    await expect(search({ SERP_PROVIDER: provider, SERP_API_KEY: 'test-key' }, 'Anne Lee', fetchImpl)).rejects.toThrow(`${provider}_429`);
  });
  it('treats autocomplete errors and unsupported providers as non-fatal', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await autocomplete({ SERP_PROVIDER: 'serper', SERP_API_KEY: 'test-key' }, 'Anne Lee ', fetchImpl)).toEqual([]);
    expect(await autocomplete({ SERP_PROVIDER: 'brave', SERP_API_KEY: 'test-key' }, 'Anne Lee ', fetchImpl)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('optional Google API web retrieval', () => {
  it.each([1, 2, 3])('uses documented fresh SerpApi Google result offsets on page %s without source/media requests', async page => {
    const fetchImpl = vi.fn(async () => Response.json(googleData('serpapi', [{ ...googleHit,
      thumbnail: 'https://media.example/private.jpg' }])));
    const output = await search(googleEnv('serpapi'), '"OpenStreetMap" & mapa', fetchImpl, { page });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url.origin + url.pathname).toBe('https://serpapi.com/search.json');
    expect(Object.fromEntries(url.searchParams)).toEqual({ engine: 'google', q: '"OpenStreetMap" & mapa',
      hl: 'en', num: '10', start: String((page - 1) * 10), no_cache: 'true', api_key: 'synthetic-server-key' });
    expect(options).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
    expect(url.searchParams.has('lr')).toBe(false);
    expect(url.searchParams.has('tbm')).toBe(false);
    expect(url.searchParams.has('async')).toBe(false);
    expect(output).toEqual({ results: [{ title: googleHit.title, url: googleHit.link, snippet: googleHit.snippet }], related: [],
      coverage: { returned: 1, invalid: 0, limited: 0, engines: ['google'] } });
    expect(JSON.stringify(output)).not.toMatch(/synthetic-server-key|serpapi\.com|thumbnail|media\.example/);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([2, 3])('refuses unverified Serper pagination instead of silently repeating page one: %s', async page => {
    const fetchImpl = vi.fn();
    await expect(search(googleEnv('serper'), 'example.com', fetchImpl, { page })).rejects.toThrow(/^serper_pagination_unavailable$/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['serper', 'serpapi'])('keeps %s query and credentials within the fixed provider request', async provider => {
    const fetchImpl = vi.fn(async () => Response.json(googleData(provider, [googleHit])));
    await search(googleEnv(provider), 'example.com', fetchImpl);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(options).toMatchObject({ redirect: 'manual', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
    if (provider === 'serper') {
      expect(url).toBe('https://google.serper.dev/search');
      expect(options.headers).toEqual({ 'X-API-KEY': 'synthetic-server-key', 'Content-Type': 'application/json', Accept: 'application/json' });
      expect(JSON.parse(options.body)).toEqual({ q: 'example.com', hl: 'en', num: 10 });
      expect(options.body).not.toContain('synthetic-server-key');
    } else {
      expect(url.origin).toBe('https://serpapi.com');
      expect(options.headers).toEqual({ Accept: 'application/json' });
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  for (const provider of ['serper', 'serpapi']) {
    it.each([null, 0, -1, 4, 1.5, '2'])(`rejects unsupported ${provider} pages before requesting: %s`, async page => {
      const fetchImpl = vi.fn();
      await expect(search(googleEnv(provider), 'example.com', fetchImpl, { page })).rejects.toThrow(new RegExp(`^${provider}_page$`));
      expect(fetchImpl).not.toHaveBeenCalled();
    });
    it.each([null, '', 'x'.repeat(501), 'example.com\nprivate'])(`rejects invalid ${provider} queries before requesting: %j`, async query => {
      const fetchImpl = vi.fn();
      await expect(search(googleEnv(provider), query, fetchImpl)).rejects.toThrow(new RegExp(`^${provider}_query$`));
      expect(fetchImpl).not.toHaveBeenCalled();
    });
    it.each([123, {}, 'key with spaces', 'key\r\nprivate-header', 'é-key', 'x'.repeat(1025)])(`rejects unsafe ${provider} key configuration without reflecting it: %j`, async key => {
      const fetchImpl = vi.fn();
      await expect(search({ ...googleEnv(provider), SERP_API_KEY: key }, 'example.com', fetchImpl)).rejects.toThrow(new RegExp(`^${provider}_configuration$`));
      expect(fetchImpl).not.toHaveBeenCalled();
    });
    it.each([null, 0, -1, 12001, Infinity, NaN, '1000'])(`rejects unsafe ${provider} timeout budgets before requesting: %s`, async timeoutMs => {
      const fetchImpl = vi.fn();
      await expect(search(googleEnv(provider), 'example.com', fetchImpl, { timeoutMs }))
        .rejects.toThrow(new RegExp(`^${provider}_timeout_configuration$`));
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it(`sanitizes ${provider} public organic metadata and conserves invalid/capped result counts`, async () => {
      const invalid = ['javascript:private-marker', 'https://user:secret@publisher.example/', 'http://127.1/',
        'http://[::1]/', 'http://10.0.0.1/', 'http://host.internal/', 'http://localhost/', 'https://publisher.example/\nprivate'];
      const incoming = [...invalid.map(link => ({ ...googleHit, link })),
        ...Array.from({ length: SEARCH_RESULT_LIMIT + 6 }, (_, i) => ({ title: i === 0 ? `<b>${'t'.repeat(650)}</b>` : `Neutral result ${i}`,
          snippet: i === 0 ? `<em>${'é'.repeat(2200)}</em>\n` : 'Public text only.', link: `https://publisher.example/${i}`, thumbnail: 'https://media.example/private.jpg',
          sitelinks: [{ link: 'https://source.example/unrequested' }], private_metadata: 'private-marker' }))];
      const fetchImpl = vi.fn(async () => Response.json({ ...googleData(provider, incoming),
        images_results: [{ original: 'https://media.example/private.jpg' }], images: [{ imageUrl: 'https://media.example/private.jpg' }],
        search_metadata: { status: 'Success', api_key: 'synthetic-server-key', raw_html_file: 'https://provider.example/private.html' } }));
      const output = await search(googleEnv(provider), 'example.com', fetchImpl);
      expect(output.results).toHaveLength(SEARCH_RESULT_LIMIT);
      expect(output.results[0]).toEqual({ title: 't'.repeat(500), url: 'https://publisher.example/0', snippet: 'é'.repeat(2000) });
      expect(output.results.some(item => item.url === 'https://publisher.example/25')).toBe(true);
      expect(output.results.every(item => Object.keys(item).sort().join(',') === 'snippet,title,url')).toBe(true);
      expect(output.coverage).toEqual({ returned: 114, invalid: 8, limited: 6, engines: ['google'] });
      expect(output.coverage.returned).toBe(output.results.length + output.coverage.invalid + output.coverage.limited);
      expect(JSON.stringify(output)).not.toMatch(/synthetic-server-key|private-marker|thumbnail|media\.example|raw_html|sitelinks/);
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it(`keeps multilingual ${provider} text and bounds safe related query strings`, async () => {
      const groups = provider === 'serper' ? { relatedSearches: [{ query: '<b>Mapa</b> de España' }, { query: 123 }],
        peopleAlsoAsk: Array.from({ length: 30 }, () => ({ question: 'q'.repeat(600), thumbnail: 'private-media' })) }
        : { related_searches: [{ query: '<b>Mapa</b> de España' }, { query: 123 }],
          related_questions: Array.from({ length: 30 }, () => ({ question: 'q'.repeat(600), thumbnail: 'private-media' })) };
      const output = await search(googleEnv(provider), 'OpenStreetMap mapa', async () => Response.json({
        ...googleData(provider, [{ ...googleHit, title: '<b>Mapa</b> de España', snippet: 'Información pública del mapa.' }]), ...groups }));
      expect(output.results[0]).toMatchObject({ title: 'Mapa de España', snippet: 'Información pública del mapa.' });
      expect(output.related).toHaveLength(20);
      expect(output.related[0]).toBe('Mapa de España');
      expect(output.related[1]).toHaveLength(500);
      expect(output.related.every(value => typeof value === 'string')).toBe(true);
    });

    it.each([
      { error: 'synthetic-server-key private-query-marker' },
      { errors: ['synthetic-server-key private-query-marker'] },
      { search_metadata: { status: 'Error', raw: 'synthetic-server-key' } },
      { search_metadata: { status: 'Processing' } },
      { search_metadata: { status: 'Queued' } },
      { statusCode: 403, message: 'Invalid API key synthetic-server-key' },
    ])(`returns a fixed safe ${provider} error for unsuccessful JSON responses: %j`, async extra => {
      const fetchImpl = vi.fn(async () => Response.json({ ...googleData(provider, [googleHit]), ...extra }));
      await expect(search(googleEnv(provider), 'example.com', fetchImpl)).rejects.toThrow(new RegExp(`^${provider}_response_error$`));
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it.each([null, 'not an array', { bad: 'synthetic-server-key' }])(`rejects malformed ${provider} organic containers: %j`, async entries => {
      await expect(search(googleEnv(provider), 'example.com', async () => Response.json(googleData(provider, entries))))
        .rejects.toThrow(new RegExp(`^${provider}_response_format$`));
    });

    it.each([302, 307, 401, 403, 429, 500])(`rejects ${provider} redirects and HTTP failures without following or reflecting body/Location: %s`, async status => {
      const cancel = vi.fn(), body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('private-query-marker synthetic-server-key')); }, cancel });
      const fetchImpl = vi.fn(async () => new Response(body, { status, headers: { Location: 'https://source.example/private-query-marker?api_key=synthetic-server-key' } }));
      await expect(search(googleEnv(provider), 'example.com', fetchImpl)).rejects.toThrow(new RegExp(`^${provider}_${status}$`));
      expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it(`bounds ${provider} advertised response size before reading private payloads`, async () => {
      const cancel = vi.fn(), body = new ReadableStream({ cancel });
      const fetchImpl = vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'application/json',
        'Content-Length': String(GOOGLE_API_MAX_BYTES + 1) } }));
      await expect(search(googleEnv(provider), 'example.com', fetchImpl)).rejects.toThrow(new RegExp(`^${provider}_response_too_large$`));
      expect(cancel).toHaveBeenCalledOnce();
    });

    it(`bounds ${provider} actual streamed bytes even with a misleading short Content-Length`, async () => {
      const bytes = new Uint8Array(GOOGLE_API_MAX_BYTES + 1), cancel = vi.fn();
      const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel });
      await expect(search(googleEnv(provider), 'example.com', async () => new Response(body,
        { headers: { 'Content-Type': 'application/json', 'Content-Length': '1' } })))
        .rejects.toThrow(new RegExp(`^${provider}_response_too_large$`));
      expect(cancel).toHaveBeenCalledOnce();
    });

    it.each([
      () => new Response('private-query-marker synthetic-server-key', { headers: { 'Content-Type': 'text/html' } }),
      () => new Response('{"private":"synthetic-server-key"'),
      () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
      () => new Response(null, { headers: { 'Content-Type': 'application/json' } }),
    ])(`sanitizes invalid ${provider} JSON/encoding/content type without exposing response content`, async makeResponse => {
      await expect(search(googleEnv(provider), 'example.com', async () => makeResponse()))
        .rejects.toThrow(new RegExp(`^${provider}_response_format$`));
    });

    it(`sanitizes ${provider} fetch failures rather than exposing a credential-bearing URL`, async () => {
      const fetchImpl = vi.fn(async () => { throw new Error('https://provider.example/?q=private-query-marker&api_key=synthetic-server-key'); });
      await expect(search(googleEnv(provider), 'example.com', fetchImpl)).rejects.toThrow(new RegExp(`^${provider}_request_failed$`));
    });

    it(`aborts ${provider} requests at twelve seconds with a fixed safe timeout`, async () => {
      vi.useFakeTimers();
      const fetchImpl = vi.fn((url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('private-query-marker synthetic-server-key')), { once: true });
      }));
      const assertion = expect(search(googleEnv(provider), 'example.com', fetchImpl)).rejects.toThrow(new RegExp(`^${provider}_timeout$`));
      await vi.advanceTimersByTimeAsync(11999);
      expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
      expect(fetchImpl).toHaveBeenCalledOnce();
    });
    it(`honors a shorter remaining deadline for the optional ${provider} backup request`, async () => {
      vi.useFakeTimers();
      const fetchImpl = vi.fn((url, options) => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('private timeout detail')), { once: true });
      }));
      const assertion = expect(search(googleEnv(provider), 'example.com', fetchImpl, { timeoutMs: 2000 }))
        .rejects.toThrow(new RegExp(`^${provider}_timeout$`));
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledOnce();
    });
  }

  it('keeps the timeout active while waiting for a SerpApi response body', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (url, options) => new Response(new ReadableStream({ start(controller) {
      options.signal.addEventListener('abort', () => controller.error(new Error('synthetic-server-key private body error')), { once: true });
    } }), { headers: { 'Content-Type': 'application/json' } }));
    const assertion = expect(search(googleEnv('serpapi'), 'example.com', fetchImpl)).rejects.toThrow(/^serpapi_timeout$/);
    await vi.advanceTimersByTimeAsync(12000);
    await assertion;
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
