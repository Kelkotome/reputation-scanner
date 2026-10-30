import { describe, it, expect, vi } from 'vitest';
import { preflightLiveSearch, preflightSearxng } from '../src/searxng-preflight.js';
import { searchSearxng } from '../src/searxng.js';

const env = { SEARXNG_URL: 'https://search.example/private/', SEARXNG_TOKEN: 'synthetic-private-token', SEARXNG_ENGINES: 'google cse' };
const neutralQueries = ['example.com', 'wikipedia', 'OpenStreetMap'];
const results = [{ title: 'Neutral result', url: 'https://publisher.example/story', snippet: 'Text only' }];
const response = engine => ({ results, coverage: { engines: [engine] } });

describe('neutral SearXNG startup verification', () => {
  it('keeps the current CSE-only connection successful after one attributed neutral probe', async () => {
    const searchImpl = vi.fn(async () => response('google cse'));
    expect(await preflightSearxng(env, searchImpl)).toEqual({ passed: true,
      checks: [{ engine: 'google cse', verified: true, attempts: 1, results: 1 }] });
    expect(searchImpl).toHaveBeenCalledOnce();
    expect(searchImpl).toHaveBeenCalledWith(env, 'example.com');
  });
  it('rejects CSE masking selected Google and an empty Brave engine, without issuing combined requests', async () => {
    const selected = { ...env, SEARXNG_ENGINES: 'google,brave,google cse' };
    const searchImpl = vi.fn(async input => input.SEARXNG_ENGINES === 'brave' ? { results: [], coverage: { engines: [] } } : response('google cse'));
    const checked = await preflightSearxng(selected, searchImpl);
    expect(checked).toEqual({ passed: false, checks: [
      { engine: 'google', verified: false, attempts: 3, results: 0, reason: 'no_attributed_results' },
      { engine: 'brave', verified: false, attempts: 3, results: 0, reason: 'no_attributed_results' },
      { engine: 'google cse', verified: true, attempts: 1, results: 1 },
    ] });
    expect(searchImpl).toHaveBeenCalledTimes(7);
    expect(searchImpl.mock.calls.every(([input, query]) => !input.SEARXNG_ENGINES.includes(',') && neutralQueries.includes(query))).toBe(true);
    expect(selected.SEARXNG_ENGINES).toBe('google,brave,google cse');
  });
  it('allows intermittent empty neutral queries to verify through a later attributed result within three probes', async () => {
    const searchImpl = vi.fn(async (input, query) => {
      const works = input.SEARXNG_ENGINES === 'google' ? query === 'wikipedia' : query === 'OpenStreetMap';
      return works ? response(input.SEARXNG_ENGINES) : { results: [], coverage: { engines: [] } };
    });
    const checked = await preflightSearxng({ ...env, SEARXNG_ENGINES: 'google,duckduckgo' }, searchImpl);
    expect(checked).toEqual({ passed: true, checks: [
      { engine: 'google', verified: true, attempts: 2, results: 1 },
      { engine: 'duckduckgo', verified: true, attempts: 3, results: 1 },
    ] });
    expect(searchImpl).toHaveBeenCalledTimes(5);
  });
  it('requires result attribution even when an engine returns nonempty metadata-free results', async () => {
    const searchImpl = vi.fn(async () => ({ results, coverage: { engines: ['unknown', 'https://search.example/', 'google-private-token'] } }));
    const checked = await preflightSearxng({ ...env, SEARXNG_ENGINES: 'google' }, searchImpl);
    expect(checked.passed).toBe(false);
    expect(checked.checks[0]).toMatchObject({ attempts: 3, reason: 'no_attributed_results' });
    expect(JSON.stringify(checked)).not.toMatch(/unknown|search\.example|private-token|publisher\.example/);
  });
  it('rejects incomplete responses even with nonempty results and exact attribution', async () => {
    const searchImpl = vi.fn(async () => ({ ...response('google cse'), partial: true }));
    expect(await preflightSearxng(env, searchImpl)).toEqual({ passed: false,
      checks: [{ engine: 'google cse', verified: false, attempts: 1, results: 0, reason: 'incomplete' }] });
    expect(searchImpl).toHaveBeenCalledOnce();
  });
  it('returns only a fixed failure reason when a provider fails and never reflects its error details', async () => {
    const searchImpl = vi.fn(async () => { throw new Error('https://search.example/private/ synthetic-private-token raw-result-body'); });
    const checked = await preflightSearxng(env, searchImpl);
    expect(checked).toEqual({ passed: false,
      checks: [{ engine: 'google cse', verified: false, attempts: 1, results: 0, reason: 'unavailable' }] });
    expect(JSON.stringify(checked)).not.toMatch(/search\.example|private-token|raw-result/);
  });
  it('does not verify Google from unusable Google URLs alongside usable CSE results', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ results: [
      { title: 'Unusable', url: 'http://localhost/private', engine: 'google' },
      { title: 'Usable CSE result', url: 'https://publisher.example/story', engine: 'google cse' },
    ] }));
    const searchImpl = (selected, query) => searchSearxng(selected, query, fetchImpl);
    const checked = await preflightSearxng({ ...env, SEARXNG_ENGINES: 'google' }, searchImpl);
    expect(checked).toEqual({ passed: false,
      checks: [{ engine: 'google', verified: false, attempts: 3, results: 0, reason: 'no_attributed_results' }] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.every(([, options]) => new URLSearchParams(options.body).get('engines') === 'google')).toBe(true);
  });
  it('rejects invalid configuration before any neutral probe', async () => {
    const searchImpl = vi.fn();
    await expect(preflightSearxng({ ...env, SEARXNG_ENGINES: 'unknown' }, searchImpl)).rejects.toThrow('searxng_configuration');
    expect(searchImpl).not.toHaveBeenCalled();
  });
});

describe('neutral startup verification with a SerpApi backup', () => {
  const backedEnv = { ...env, SERP_PROVIDER: 'searxng', SEARXNG_ENGINES: 'google,bing,google cse',
    GOOGLE_BACKUP_PROVIDER: 'serpapi', SERPAPI_API_KEY: 'synthetic-serpapi-private-key' };

  it('allows degraded startup with Bing and the verified Google backup while retaining failed primary checks', async () => {
    const searchImpl = vi.fn(async input => input.SERP_PROVIDER === 'serpapi'
      ? response('google') : input.SEARXNG_ENGINES === 'bing' ? response('bing') : { results: [], coverage: { engines: [] } });
    const checked = await preflightLiveSearch(backedEnv, searchImpl);
    expect(checked).toMatchObject({ passed: true, degraded: true, primary: { passed: false },
      backup: { provider: 'serpapi', verified: true, attempts: 1, results: 1 } });
    expect(checked.primary.checks.filter(check => check.verified).map(check => check.engine)).toEqual(['bing']);
    const backupCalls = searchImpl.mock.calls.filter(([input]) => input.SERP_PROVIDER === 'serpapi');
    expect(backupCalls).toHaveLength(1);
    expect(backupCalls[0][1]).toBe('wikipedia');
    expect(backupCalls[0][0].SERP_API_KEY).toBe(backedEnv.SERPAPI_API_KEY);
    expect(backupCalls[0][0].SERP_GL).toBe('');
    expect(backedEnv.SERP_API_KEY).toBeUndefined();
    expect(JSON.stringify(checked)).not.toMatch(/synthetic|private-key|publisher\.example/);
  });

  it('allows verified primary engines to start when the backup fails without exposing its error', async () => {
    const searchImpl = vi.fn(async input => {
      if (input.SERP_PROVIDER === 'serpapi') throw new Error('synthetic-serpapi-private-key raw response');
      return response(input.SEARXNG_ENGINES);
    });
    const checked = await preflightLiveSearch(backedEnv, searchImpl);
    expect(checked).toMatchObject({ passed: true, degraded: false, primary: { passed: true },
      backup: { verified: false, attempts: 1, results: 0, reason: 'unavailable' } });
    expect(JSON.stringify(checked)).not.toMatch(/synthetic|raw response/);
  });

  it('does not claim a working primary when every SearXNG engine fails even with a working backup', async () => {
    const searchImpl = vi.fn(async input => input.SERP_PROVIDER === 'serpapi'
      ? response('google') : { results: [], coverage: { engines: [] } });
    const checked = await preflightLiveSearch(backedEnv, searchImpl);
    expect(checked).toMatchObject({ passed: false, degraded: true, primary: { passed: false }, backup: { verified: true } });
    expect(checked.primary.checks.every(check => !check.verified)).toBe(true);
  });

  it.each([undefined, '', 'space in key', 'line\nbreak', 'x'.repeat(1025)])('never calls SerpApi with a missing or invalid key', async key => {
    const searchImpl = vi.fn(async input => response(input.SEARXNG_ENGINES));
    const checked = await preflightLiveSearch({ ...backedEnv, SERPAPI_API_KEY: key }, searchImpl);
    expect(checked).toMatchObject({ passed: true, backup: { verified: false, attempts: 0, reason: 'configuration' } });
    expect(searchImpl.mock.calls.every(([input]) => input.SERP_PROVIDER === 'searxng')).toBe(true);
  });

  it('keeps strict primary verification when the backup is disabled', async () => {
    const searchImpl = vi.fn(async input => input.SEARXNG_ENGINES === 'bing' ? response('bing') : { results: [] });
    const checked = await preflightLiveSearch({ ...backedEnv, GOOGLE_BACKUP_PROVIDER: 'none' }, searchImpl);
    expect(checked).toMatchObject({ passed: false, backup: { enabled: false, attempts: 0, reason: 'disabled' } });
    expect(searchImpl.mock.calls.every(([input]) => input.SERP_PROVIDER === 'searxng')).toBe(true);
  });

  it('rejects degraded startup when its configured backup cannot verify', async () => {
    const searchImpl = vi.fn(async input => {
      if (input.SERP_PROVIDER === 'serpapi') throw new Error('private provider response');
      return input.SEARXNG_ENGINES === 'bing' ? response('bing') : { results: [] };
    });
    const checked = await preflightLiveSearch(backedEnv, searchImpl);
    expect(checked).toMatchObject({ passed: false, degraded: true,
      backup: { verified: false, attempts: 1, reason: 'unavailable' } });
    expect(checked.primary.checks.filter(check => check.verified).map(check => check.engine)).toEqual(['bing']);
  });

  it('requires a complete Google-attributed backup response instead of accepting another engine', async () => {
    const searchImpl = vi.fn(async input => input.SERP_PROVIDER === 'serpapi' ? response('bing') : response(input.SEARXNG_ENGINES));
    const checked = await preflightLiveSearch(backedEnv, searchImpl);
    expect(checked.backup).toMatchObject({ verified: false, attempts: 1, reason: 'no_attributed_results' });
    searchImpl.mockImplementation(async input => input.SERP_PROVIDER === 'serpapi'
      ? { ...response('google'), partial: true } : response(input.SEARXNG_ENGINES));
    expect((await preflightLiveSearch(backedEnv, searchImpl)).backup).toMatchObject({ verified: false, attempts: 1, reason: 'incomplete' });
  });
});
