import { describe, it, expect, vi } from 'vitest';
import { recoverMissingGoogle } from '../src/searxng-recovery.js';
import { searchSearxng } from '../src/searxng.js';
import { SEARCH_RESULT_LIMIT } from '../src/search-limits.js';

const env = { SEARXNG_URL: 'https://search.example/private/', SEARXNG_TOKEN: 'synthetic-private-token',
  SEARXNG_ENGINES: 'google,duckduckgo,google cse' };
const hit = (number = 1) => ({ title: `Neutral result ${number}`, url: `https://publisher.example/story/${number}`, snippet: 'Text only' });
const response = (engines = ['google cse'], results = [hit()]) => ({ results, related: [],
  coverage: { returned: results.length, invalid: 0, limited: 0, engines } });
const hooks = () => ({ reserve: vi.fn(async () => 'reservation'), finish: vi.fn(async () => {}),
  searchImpl: vi.fn(async () => response(['google'], [hit(2)])), fetchImpl: vi.fn() });

describe('bounded recovery for silent empty Google coverage', () => {
  it('uses an explicitly selected independent backup for a partial primary without repeating the failed service', async () => {
    const callbacks=hooks(), first={...response(['bing']),partial:true};
    const output=await recoverMissingGoogle(env,'wikipedia',first,{...callbacks,backupProvider:'serpapi'});
    expect(output.partial).toBe(true);
    expect(output.results).toEqual([hit(),hit(2)]);
    expect(output.coverage).toMatchObject({google_backup_provider:'serpapi',google_recovery:'recovered',attempts:2});
    expect(callbacks.searchImpl).toHaveBeenCalledOnce();
    expect(callbacks.finish).toHaveBeenCalledWith('reservation',true);
    expect(first.partial).toBe(true);
  });
  it('does not treat arbitrary backup names as authorization to recover an explicit failure', async () => {
    const callbacks=hooks(),first={...response(),partial:true};
    expect(await recoverMissingGoogle(env,'wikipedia',first,{...callbacks,backupProvider:'untrusted-provider'})).toBe(first);
    expect(callbacks.reserve).not.toHaveBeenCalled();
  });
  it('reserves before one Google-only request with identical query/page and settles attributed results once', async () => {
    const first = response(), original = structuredClone(first), order = [], callbacks = hooks();
    callbacks.reserve.mockImplementation(async () => { order.push('reserve'); return 'reservation'; });
    callbacks.searchImpl.mockImplementation(async () => { order.push('search'); return response(['google'], [hit(2)]); });
    callbacks.finish.mockImplementation(async () => { order.push('finish'); });
    const output = await recoverMissingGoogle(env, 'OpenStreetMap mapa', first, { ...callbacks, page: 2, remainingMs: () => 3500 });
    expect(output).toEqual({ results: [hit(), hit(2)], related: [], coverage: {
      returned: 2, invalid: 0, limited: 0, engines: ['google cse', 'google'], google_recovery: 'recovered', attempts: 2,
    } });
    expect(callbacks.searchImpl).toHaveBeenCalledOnce();
    expect(callbacks.searchImpl).toHaveBeenCalledWith({ ...env, SEARXNG_ENGINES: 'google' },
      'OpenStreetMap mapa', callbacks.fetchImpl, { page: 2, timeoutMs: 3500 });
    expect(callbacks.finish.mock.calls).toEqual([['reservation', true]]);
    expect(order).toEqual(['reserve', 'search', 'finish']);
    expect(first).toEqual(original);
    expect(env.SEARXNG_ENGINES).toBe('google,duckduckgo,google cse');
  });

  it('uses the query-only all-language transport and never makes more than one additional provider request', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ results: [{ title: 'Mapa de España',
      content: 'Mapa público.', url: 'https://publisher.example/mapa', engine: 'google', thumbnail: 'https://media.example/private.jpg' }] }));
    const output = await recoverMissingGoogle(env, 'OpenStreetMap mapa', response(), { searchImpl: searchSearxng, fetchImpl, page: 3,
      reserve: async () => 'reservation' });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url.href).toBe('https://search.example/private/search');
    expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({ q: 'OpenStreetMap mapa',
      format: 'json', language: 'all', safesearch: '0', engines: 'google', pageno: '3' });
    expect(output.coverage).toMatchObject({ google_recovery: 'recovered', attempts: 2 });
    expect(JSON.stringify(output)).not.toMatch(/synthetic-private-token|search\.example|thumbnail|media\.example/);
  });

  it.each([
    { selected: 'google cse', first: response() },
    { selected: 'duckduckgo,google cse', first: response() },
    { selected: 'google,google cse', first: response(['google', 'google cse']) },
    { selected: 'unknown', first: response() },
    { selected: 'google', first: { ...response(), partial: true } },
    { selected: 'google', first: { ...response(), error: 'captcha' } },
    { selected: 'google', first: { ...response(), errors: ['rate limited'] } },
    { selected: 'google', first: { ...response(), unresponsive_engines: [['google', 'captcha']] } },
    { selected: 'google', first: { ...response(), captcha: true } },
    { selected: 'google', first: { ...response(), rate_limited: true } },
    { selected: 'google', first: { ...response(), status: 429 } },
    { selected: 'google', first: { ...response(), status: 403 } },
    { selected: 'google', first: { results: null } },
    { selected: 'google', first: { ...response(), results: [{ ...hit(), url: 'http://localhost/private' }] } },
    { selected: 'google', first: { ...response(), results: [{ title: 'Missing snippet', url: hit().url }] } },
    { selected: 'google', first: { ...response(), coverage: { ...response().coverage, returned: 3 } } },
    { selected: 'google', first: { ...response(), coverage: { ...response().coverage, invalid: -1 } } },
    { selected: 'google', first: { ...response(), coverage: { ...response().coverage, returned: '1' } } },
    { selected: 'google', first: { ...response(), coverage: { ...response().coverage, limited: NaN } } },
    { selected: 'google', first: { ...response(), coverage: { ...response().coverage, attempts: 2, google_recovery: 'empty' } } },
  ])('does not reserve or retry ineligible first responses: %j', async ({ selected, first }) => {
    const callbacks = hooks();
    expect(await recoverMissingGoogle({ ...env, SEARXNG_ENGINES: selected }, 'example.com', first, callbacks)).toBe(first);
    expect(callbacks.reserve).not.toHaveBeenCalled();
    expect(callbacks.searchImpl).not.toHaveBeenCalled();
    expect(callbacks.finish).not.toHaveBeenCalled();
  });

  it('records an empty completed retry without claiming Google coverage or settling success', async () => {
    const callbacks = hooks();
    callbacks.searchImpl.mockResolvedValue(response([], []));
    const output = await recoverMissingGoogle(env, 'example.com', response(), callbacks);
    expect(output.coverage).toEqual({ returned: 1, invalid: 0, limited: 0, engines: ['google cse'], google_recovery: 'empty', attempts: 2 });
    expect(callbacks.searchImpl).toHaveBeenCalledOnce();
    expect(callbacks.finish.mock.calls).toEqual([['reservation', false]]);
  });

  it('can recover a structurally valid empty first response within the same one-retry bound', async () => {
    const callbacks = hooks();
    const output = await recoverMissingGoogle(env, 'example.com', response([], []), callbacks);
    expect(output.results).toEqual([hit(2)]);
    expect(output.coverage).toEqual({ returned: 1, invalid: 0, limited: 0, engines: ['google'], google_recovery: 'recovered', attempts: 2 });
    expect(callbacks.searchImpl).toHaveBeenCalledOnce();
    expect(callbacks.finish.mock.calls).toEqual([['reservation', true]]);
  });

  it('does not recover Google health from unusable URLs, while preserving the parser invalid count', async () => {
    const callbacks = hooks();
    const fetchImpl = vi.fn(async () => Response.json({ results: [{ title: 'Unusable', content: 'Not retained',
      url: 'http://localhost/private', engine: 'google' }] }));
    const output = await recoverMissingGoogle(env, 'example.com', response(), {
      ...callbacks, searchImpl: searchSearxng, fetchImpl,
    });
    expect(output.results).toEqual([hit()]);
    expect(output.coverage).toEqual({ returned: 2, invalid: 1, limited: 0, engines: ['google cse'], google_recovery: 'empty', attempts: 2 });
    expect(callbacks.finish.mock.calls).toEqual([['reservation', false]]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects nonempty CSE-only retry attribution without treating it as empty or recovered Google', async () => {
    const callbacks = hooks();
    callbacks.searchImpl.mockResolvedValue(response(['google cse', 'unknown', 'google-private-token'], [{ ...hit(), snippet: 'Additional public context' }]));
    const output = await recoverMissingGoogle(env, 'example.com', response(), callbacks);
    expect(output.results).toEqual([hit()]);
    expect(output.coverage).toEqual({ returned: 1, invalid: 0, limited: 0, engines: ['google cse'], google_recovery: 'failed', attempts: 2 });
    expect(callbacks.finish.mock.calls).toEqual([['reservation', false]]);
  });

  it('retains same-URL Google duplicates and later metadata for browser enrichment', async () => {
    const callbacks = hooks();
    callbacks.searchImpl.mockResolvedValue(response(['google'], [{ ...hit(), snippet: 'Additional public context' }]));
    const output = await recoverMissingGoogle(env, 'example.com', response(), callbacks);
    expect(output.results).toEqual([hit(), { ...hit(), snippet: 'Additional public context' }]);
    expect(output.coverage).toMatchObject({ returned: 2, google_recovery: 'recovered', attempts: 2 });
    expect(callbacks.finish.mock.calls).toEqual([['reservation', true]]);
  });

  it.each([
    { ...response(['google']), partial: true },
    { ...response(['google']), error: 'private query / captcha / secret-token' },
    { ...response(['google']), status: 429 },
    { ...response(['google']), results: [{ ...hit(), url: 'javascript:secret-token' }] },
    { results: null },
    { ...response(['google']), coverage: { ...response(['google']).coverage, returned: 3 } },
    { ...response(['google']), coverage: { ...response(['google']).coverage, invalid: -1 } },
    { ...response(['google']), coverage: { ...response(['google']).coverage, limited: NaN } },
  ])('keeps the first safe response when retry is unsuccessful or malformed: %j', async retry => {
    const callbacks = hooks();
    callbacks.searchImpl.mockResolvedValue(retry);
    const output = await recoverMissingGoogle(env, 'example.com', response(), callbacks);
    expect(output.results).toEqual([hit()]);
    expect(output.coverage).toEqual({ returned: 1, invalid: 0, limited: 0, engines: ['google cse'], google_recovery: 'failed', attempts: 2 });
    expect(callbacks.searchImpl).toHaveBeenCalledOnce();
    expect(callbacks.finish.mock.calls).toEqual([['reservation', false]]);
    expect(JSON.stringify(output)).not.toMatch(/captcha|secret-token|javascript/);
  });

  it.each(['searxng_http_429', 'searxng_http_403', 'searxng_engines_unavailable', 'raw captcha response / synthetic-private-token'])('never repeats a failed retry or reflects provider errors: %s', async message => {
    const callbacks = hooks();
    callbacks.searchImpl.mockRejectedValue(new Error(message));
    const output = await recoverMissingGoogle(env, 'example.com', response(), callbacks);
    expect(output.results).toEqual([hit()]);
    expect(output.coverage).toMatchObject({ google_recovery: 'failed', attempts: 2 });
    expect(callbacks.searchImpl).toHaveBeenCalledOnce();
    expect(callbacks.finish.mock.calls).toEqual([['reservation', false]]);
    expect(JSON.stringify(output)).not.toContain(message);
  });

  it.each([null, undefined, false])('skips recovery without a reservation: %s', async reservation => {
    const callbacks = hooks();
    callbacks.reserve.mockResolvedValue(reservation);
    const output = await recoverMissingGoogle(env, 'example.com', response(), callbacks);
    expect(output.results).toEqual([hit()]);
    expect(output.coverage).toMatchObject({ google_recovery: 'budget_skipped', attempts: 1 });
    expect(callbacks.reserve).toHaveBeenCalledOnce();
    expect(callbacks.searchImpl).not.toHaveBeenCalled();
    expect(callbacks.finish).not.toHaveBeenCalled();
  });

  it('does not expose reservation errors or fetch after a budget failure', async () => {
    const callbacks = hooks();
    callbacks.reserve.mockRejectedValue(new Error('private billing key'));
    const output = await recoverMissingGoogle(env, 'example.com', response(), callbacks);
    expect(output.coverage).toMatchObject({ google_recovery: 'budget_skipped', attempts: 1 });
    expect(callbacks.searchImpl).not.toHaveBeenCalled();
    expect(callbacks.finish).not.toHaveBeenCalled();
    expect(JSON.stringify(output)).not.toContain('private billing key');
  });

  it('fails closed without an explicit reservation hook', async () => {
    const callbacks = hooks();
    const output = await recoverMissingGoogle(env, 'example.com', response(), {
      searchImpl: callbacks.searchImpl, fetchImpl: callbacks.fetchImpl, finish: callbacks.finish,
    });
    expect(output.coverage).toMatchObject({ google_recovery: 'budget_skipped', attempts: 1 });
    expect(callbacks.searchImpl).not.toHaveBeenCalled();
    expect(callbacks.finish).not.toHaveBeenCalled();
  });

  it.each([999, 0, -1, NaN, Infinity])('skips before reservation when remaining time is insufficient or invalid: %s', async remainingMs => {
    const callbacks = hooks();
    const output = await recoverMissingGoogle(env, 'example.com', response(), { ...callbacks, remainingMs: () => remainingMs });
    expect(output.coverage).toMatchObject({ google_recovery: 'time_skipped', attempts: 1 });
    expect(callbacks.reserve).not.toHaveBeenCalled();
    expect(callbacks.searchImpl).not.toHaveBeenCalled();
    expect(callbacks.finish).not.toHaveBeenCalled();
  });

  it('rechecks the deadline after reservation and settles once without fetching if time expired', async () => {
    const callbacks = hooks(), remainingMs = vi.fn().mockReturnValueOnce(1200).mockReturnValueOnce(999);
    const output = await recoverMissingGoogle(env, 'example.com', response(), { ...callbacks, remainingMs });
    expect(output.coverage).toMatchObject({ google_recovery: 'time_skipped', attempts: 1 });
    expect(callbacks.reserve).toHaveBeenCalledOnce();
    expect(callbacks.searchImpl).not.toHaveBeenCalled();
    expect(callbacks.finish.mock.calls).toEqual([['reservation', false]]);
  });

  it.each([1000, 12000, 50000])('bounds retry timeout within the remaining deadline: %s', async remainingMs => {
    const callbacks = hooks();
    await recoverMissingGoogle(env, 'example.com', response(), { ...callbacks, remainingMs });
    expect(callbacks.searchImpl.mock.calls[0][3].timeoutMs).toBe(Math.min(12000, remainingMs));
  });

  it('caps merged metadata at 100 while conserving input counts, engine labels and existing-first order', async () => {
    const firstResults = Array.from({ length: 80 }, (_, i) => hit(i)), retryResults = Array.from({ length: 50 }, (_, i) => hit(i + 80));
    const first = { ...response(['google cse'], firstResults), coverage: { returned: 84, invalid: 3, limited: 1,
      engines: ['google cse', 'secret-token'], private_metadata: 'secret-token' }, private_metadata: 'secret-token' };
    const callbacks = hooks();
    callbacks.searchImpl.mockResolvedValue({ ...response(['google'], retryResults), coverage: { returned: 55,
      invalid: 2, limited: 3, engines: ['GOOGLE', 'https://search.example/'] }, raw_response: 'secret-token' });
    const output = await recoverMissingGoogle(env, 'example.com', first, callbacks);
    expect(output.results).toEqual([...firstResults, ...retryResults.slice(0, 20)]);
    expect(output.results).toHaveLength(SEARCH_RESULT_LIMIT);
    expect(output.coverage).toEqual({ returned: 139, invalid: 5, limited: 34, engines: ['google cse', 'google'],
      google_recovery: 'recovered', attempts: 2 });
    expect(output.coverage.returned).toBe(output.results.length + output.coverage.invalid + output.coverage.limited);
    expect(JSON.stringify(output)).not.toMatch(/secret-token|search\.example|private_metadata|raw_response/);
  });

  it('keeps only bounded public fields and conserved counts when adding recovery diagnostics', async () => {
    const first = { results: [{ ...hit(), thumbnail: 'https://media.example/private.jpg' }],
      related: ['not exposed'], coverage: { returned: 1, invalid: 0, limited: 0, engines: ['google cse', 'secret-token'] },
      raw_response: 'secret-token' };
    const callbacks = hooks();
    callbacks.searchImpl.mockResolvedValue(response([], []));
    const output = await recoverMissingGoogle(env, 'example.com', first, callbacks);
    expect(output).toEqual({ results: [hit()], related: [], coverage: { returned: 1, invalid: 0, limited: 0,
      engines: ['google cse'], google_recovery: 'empty', attempts: 2 } });
  });

  it('does not lose recovered metadata or leak settlement errors when finish fails', async () => {
    const callbacks = hooks();
    callbacks.finish.mockRejectedValue(new Error('private reservation response'));
    const output = await recoverMissingGoogle(env, 'example.com', response(), callbacks);
    expect(output.coverage).toMatchObject({ google_recovery: 'recovered', attempts: 2 });
    expect(callbacks.finish.mock.calls).toEqual([['reservation', true]]);
    expect(JSON.stringify(output)).not.toContain('private reservation response');
  });
});
