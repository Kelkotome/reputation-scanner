import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stepScan } from '../src/pipeline.js';
import { cacheKey } from '../src/budget.js';
import { expandQueries } from '../src/expand.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
let sqlite, env, fetchImpl, sequence;
const query = '"Anne Lee"';

function prepare(sql, args = []) {
  const run = () => {
    const result = sqlite.prepare(sql).run(...args);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  };
  return {
    bind: (...values) => prepare(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => run(), runSync: run,
  };
}

function addScan(context, { status = 'searching', provider = 'serpapi' } = {}) {
  const id = `country-scan-${++sequence}`;
  sqlite.prepare(`INSERT INTO scans (id, created_at, full_name, name_norm, context_json, provider, status)
    VALUES (?, ?, 'Anne Lee', 'anne lee', ?, ?, ?)`).run(id, Date.now(), JSON.stringify(context), provider, status);
  if (status === 'searching') {
    sqlite.prepare('INSERT INTO queries (scan_id, q, priority, source) VALUES (?, ?, 1, ?)').run(id, query, 'seed');
  }
  return id;
}

async function finishSearch(context, options) {
  const id = addScan(context, options);
  for (let i = 0; i < 5; i++) {
    await stepScan(env, id, { fetchImpl });
    if (sqlite.prepare('SELECT status FROM scans WHERE id = ?').get(id).status === 'done') break;
  }
  expect(sqlite.prepare('SELECT status FROM scans WHERE id = ?').get(id).status).toBe('done');
  return id;
}

beforeEach(() => {
  sequence = 0;
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = {
    SERP_PROVIDER: 'serpapi', SERP_GL: 'sg', SERP_API_KEY: 'test-key', CLOUD_AI_ENABLED: 'false',
    MAX_QUERIES: 1, SEARCH_BATCH: 1,
    DB: { prepare, batch: async statements => {
      sqlite.exec('BEGIN');
      try { const result = statements.map(statement => statement.runSync()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    } },
  };
  // Empty results isolate provider requests from optional page enrichment.
  fetchImpl = vi.fn(async () => Response.json({ organic_results: [], organic: [], suggestions: [] }));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request in offline test'); }));
});
afterEach(() => { vi.unstubAllGlobals(); sqlite.close(); });

describe('scan country selection and SERP cache isolation', () => {
  it.each([
    ['us', 'United States', 'us'],
    ['', '', null],
  ])('passes saved country %j to autocomplete and search despite the deployment default', async (countryCode, country, expectedGl) => {
    const id = addScan({ country_code: countryCode, country }, { status: 'planning' });
    await stepScan(env, id, { fetchImpl });
    expect(sqlite.prepare('SELECT status FROM scans WHERE id = ?').get(id).status).toBe('searching');
    await stepScan(env, id, { fetchImpl });
    expect(sqlite.prepare('SELECT status FROM scans WHERE id = ?').get(id).status).toBe('done');
    const requests = fetchImpl.mock.calls.map(([url]) => new URL(url));
    expect(requests).toHaveLength(3);
    expect(requests.map(url => url.searchParams.get('engine'))).toEqual(['google_autocomplete', 'google_autocomplete', 'google']);
    expect(requests.map(url => url.searchParams.get('gl'))).toEqual([expectedGl, expectedGl, expectedGl]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reuses only the same country preference, including an explicit no-preference selection', async () => {
    await finishSearch({ country_code: 'us', country: 'United States' });
    const repeated = await finishSearch({ country_code: 'us', country: 'United States' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT serp_queries FROM scans WHERE id = ?').get(repeated).serp_queries).toBe(0);
    await finishSearch({ country_code: 'sg', country: 'Singapore' });
    await finishSearch({ country_code: '', country: '' });
    const repeatedNone = await finishSearch({ country_code: '', country: '' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url).searchParams.get('gl'))).toEqual(['us', 'sg', null]);
    expect(sqlite.prepare('SELECT serp_queries FROM scans WHERE id = ?').get(repeatedNone).serp_queries).toBe(0);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM serp_cache').get().n).toBe(3);
  });

  it('isolates legacy scans and pre-geography caches from new country selections', async () => {
    sqlite.prepare('INSERT INTO serp_cache (key, json, created_at) VALUES (?, ?, ?)')
      .run(cacheKey('serpapi', query), JSON.stringify({ results: [], related: [] }), Date.now());
    // The old label did not control SERP geography. The deployment still does.
    await finishSearch({ country: 'United States' });
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('gl')).toBe('sg');
    await finishSearch({ country: 'United States' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await finishSearch({ country_code: 'sg', country: 'Singapore' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // A deployment geography change must also invalidate legacy cache reuse.
    env.SERP_GL = 'us';
    await finishSearch({ country: 'United States' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new URL(fetchImpl.mock.calls[2][0]).searchParams.get('gl')).toBe('us');
    await finishSearch({ country_code: 'us', country: 'United States' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('isolates providers even when query and country match', async () => {
    await finishSearch({ country_code: 'us', country: 'United States' });
    await finishSearch({ country_code: 'us', country: 'United States' }, { provider: 'serper' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('https://serpapi.com/');
    expect(fetchImpl.mock.calls[1][0]).toBe('https://google.serper.dev/search');
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).gl).toBe('us');
  });

  it('retains separate person and business mock fixtures within the new country cache', async () => {
    const country = { country_code: 'sg', country: 'Singapore' };
    const person = await finishSearch(country, { provider: 'mock' });
    const business = await finishSearch({ ...country, subject_type: 'business', representative_name: 'Ari Tan' }, { provider: 'mock' });
    const profile = id => sqlite.prepare("SELECT url FROM hits WHERE scan_id = ? AND url LIKE 'https://sg.linkedin.com/%'").get(id).url;
    expect(profile(person)).toContain('/in/anne-lee');
    expect(profile(business)).toContain('/company/anne-lee');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM serp_cache').get().n).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not invent Singapore context when query expansion has no country preference', async () => {
    const modelFetch = vi.fn(async () => Response.json({ content: [{ type: 'tool_use', input: { queries: [] } }] }));
    await expandQueries({ CLOUD_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' }, { full_name: 'Anne Lee', context: { country_code: '', country: '' } }, ['anne lee'], modelFetch);
    const request = JSON.parse(modelFetch.mock.calls[0][1].body);
    expect(JSON.parse(request.messages[0].content).country).toBe('');
    expect(fetch).not.toHaveBeenCalled();
  });
});
