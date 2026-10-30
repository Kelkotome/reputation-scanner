import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createBrowserScans } from '../src/browser-scans.js';

const NOW = Date.UTC(2026, 8, 25, 12);
const base = { full_name: 'Anne Lee', email: 'anne@example.com', is_minor: false, attestation: true,
  harm_types: ['scam_fraud'], context: { country_code: 'sg' } };
const business = { ...base, subject_type: 'business', full_name: 'Acme Studio', email: 'private@acme.example',
  context: { country_code: 'uk', industry: 'Design', representative_name: 'Private Representative', website: 'https://acme.example/about?private=discard' } };
const fixture = (name = 'Anne Lee', url = 'https://news.example/story') => ({ title: `${name} scam allegation`, url, snippet: `${name} fraud complaint Singapore` });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function memoryStore() {
  const records = new Map(), tails = new Map(), keyOf = (kind, id) => `${kind}:${id}`;
  const enqueue = (kind, id, operation) => {
    const key = keyOf(kind, id), result = (tails.get(key) || Promise.resolve()).then(() => operation(key));
    tails.set(key, result.catch(() => {})); return result;
  };
  return {
    records,
    get: vi.fn(async (kind, id) => { const key = keyOf(kind, id); await (tails.get(key) || Promise.resolve()); return structuredClone(records.get(key)); }),
    put: vi.fn((kind, id, value) => enqueue(kind, id, key => records.set(key, structuredClone(value)))),
    remove: vi.fn((kind, id) => enqueue(kind, id, key => records.delete(key))),
    update: vi.fn((kind, id, mutate) => enqueue(kind, id, key => {
      if (!records.has(key)) return undefined;
      const result = mutate(structuredClone(records.get(key)));
      if (result?.then) throw new Error('Mutator must be synchronous');
      records.set(key, structuredClone(result)); return structuredClone(result);
    })),
    list: vi.fn(async kind => [...records.entries()].filter(([key]) => !kind || key.startsWith(`${kind}:`)).map(([, record]) => structuredClone(record))),
  };
}

let store, handle, cfg, config, relay, permit, sequence, clock;
const path = id => `/api/scan/${id}`;
const create = async (extra = {}) => (await handle('/api/scan', { method: 'POST', body: { ...base, ...extra } })).id;
const read = id => store.get('scan', id);
const poll = id => handle(path(id));
const draft = (scanId, hitId, body) => handle(`/api/hit/${hitId}/draft`, { method: 'POST', scanId, body });
const status = (scanId, hitId, status) => handle(`/api/hit/${hitId}`, { method: 'PATCH', scanId, body: { status } });
async function finish(id) {
  for (let i = 0; i < 30; i++) { const result = await poll(id); if (['done', 'error', 'paused_budget', 'awaiting_import'].includes(result.status)) return result; }
  throw new Error('Scan did not finish');
}
function live(max = 3) { cfg = { ...cfg, provider: 'serpapi', search_relay_enabled: true, max_queries: max }; }
function quota({ operator = false, max = 12 } = {}) {
  cfg = { ...cfg, provider: 'searxng', search_relay_enabled: true, operator, scan_ticket_required: true, public_daily_limit: 3, max_queries: max };
}
const permitResult = () => ({ search_ticket: `ticket-${clock}`, expires_at: (Math.floor(clock / 86_400_000) + 1) * 86_400_000,
  reset_at: (Math.floor(clock / 86_400_000) + 1) * 86_400_000, remaining_scans: cfg.operator ? null : 2, max_requests: cfg.operator ? 122 : 26 });
async function importedScan(extra = {}, items = [fixture()]) {
  cfg.provider = 'session';
  const id = await create(extra); await poll(id);
  const { queries } = await handle(`${path(id)}/queries`);
  await handle(`${path(id)}/import`, { method: 'POST', body: { results: [{ q: queries[0].q, items }] } });
  return id;
}
async function importNextQuery(id, items) {
  const { queries } = await handle(`${path(id)}/queries`);
  const query = queries[0];
  const response = await handle(`${path(id)}/import`, { method: 'POST', body: { results: [{ q: query.q, items }] } });
  return { query, response };
}

beforeEach(() => {
  store = memoryStore(); sequence = 0; clock = NOW;
  cfg = { provider: 'mock', max_queries: 6, show_limit: 10, search_relay_enabled: false };
  config = vi.fn(async () => cfg);
  permit = vi.fn(async () => permitResult());
  relay = vi.fn(async ({ kind }) => kind === 'autocomplete' ? { suggestions: [] } : { results: [fixture()], related: [] });
  handle = createBrowserScans({ store, config, relay, permit, now: () => clock,
    uuid: () => `12345678-1234-4234-8234-${String(++sequence).padStart(12, '0')}` });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Only an injected query relay may access the network'); }));
});
afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.unstubAllGlobals(); } });

describe('browser-owned scan service', () => {
  it('saves explicit available SerpApi backup consent and sends only the scoped permission with queries', async () => {
    quota({ max: 1 });
    cfg.google_backup_provider = 'serpapi'; cfg.google_backup_available = true;
    const id = await create({ live_search_consent: true, google_backup_consent: true });
    expect(await read(id)).toMatchObject({ google_backup_consent: true, configured_google_backup_provider: 'serpapi' });
    const result = await finish(id);
    expect(result).toMatchObject({ google_backup_consent: true, configured_google_backup_provider: 'serpapi' });
    expect(relay).toHaveBeenCalledOnce();
    expect(relay.mock.calls[0][0]).toMatchObject({ google_backup_consent: true, kind: 'search', country_code: '' });
    expect(Object.keys(relay.mock.calls[0][0]).sort()).toEqual(['country_code', 'google_backup_consent', 'kind', 'q', 'search_ticket']);
    expect(JSON.stringify(relay.mock.calls)).not.toMatch(/anne@example\.com|12345678|configured_google_backup_provider/);
  });

  it.each([undefined, false, 'true', 1])('does not broaden live sharing consent into backup consent: %j', async google_backup_consent => {
    quota({ max: 1 }); cfg.google_backup_provider = 'serpapi'; cfg.google_backup_available = true;
    const id = await create({ live_search_consent: true, google_backup_consent });
    expect((await read(id)).google_backup_consent).toBe(false);
    await finish(id);
    expect(relay.mock.calls[0][0]).not.toHaveProperty('google_backup_consent');
  });

  it.each([
    { google_backup_provider: 'serpapi', google_backup_available: false },
    { google_backup_provider: 'serpapi', google_backup_available: 'true' },
    { google_backup_provider: 'unknown-private-provider', google_backup_available: true },
    { google_backup_available: true },
  ])('ignores requested backup permission for unavailable or unsupported configuration: %j', async settings => {
    quota({ max: 1 }); Object.assign(cfg, settings);
    const id = await create({ live_search_consent: true, google_backup_consent: true });
    expect(await read(id)).toMatchObject({ google_backup_consent: false, configured_google_backup_provider: null });
    const result = await finish(id);
    expect(relay.mock.calls[0][0]).not.toHaveProperty('google_backup_consent');
    expect(JSON.stringify(result)).not.toContain('unknown-private-provider');
  });

  it('does not authorize a backup without live search consent or for a different primary provider', async () => {
    quota({ max: 1 }); cfg.google_backup_provider = 'serpapi'; cfg.google_backup_available = true;
    await expect(create({ google_backup_consent: true })).rejects.toMatchObject({ status: 403 });
    expect(store.put).not.toHaveBeenCalled();
    live(1);
    const id = await create({ live_search_consent: true, google_backup_consent: true });
    expect(await read(id)).toMatchObject({ google_backup_consent: false, configured_google_backup_provider: null });
    await finish(id);
    expect(relay.mock.calls.every(([body]) => !Object.hasOwn(body, 'google_backup_consent'))).toBe(true);
  });

  it('keeps legacy scan consent unchanged when a backup becomes available later', async () => {
    quota({ max: 1 });
    const id = await create({ live_search_consent: true });
    await store.update('scan', id, ({ google_backup_consent, configured_google_backup_provider, ...legacy }) => legacy);
    cfg.google_backup_provider = 'serpapi'; cfg.google_backup_available = true;
    const result = await finish(id);
    expect(result).toMatchObject({ google_backup_consent: false, configured_google_backup_provider: null });
    expect(await read(id)).not.toHaveProperty('google_backup_consent');
    expect(relay.mock.calls[0][0]).not.toHaveProperty('google_backup_consent');
  });

  it.each([
    { google_backup_provider: 'unsupported', google_backup_available: true },
    { google_backup_provider: 'serpapi', google_backup_available: false },
  ])('withholds stored backup permission when current settings no longer match the consent snapshot: %j', async settings => {
    quota({ max: 1 }); cfg.google_backup_provider = 'serpapi'; cfg.google_backup_available = true;
    const id = await create({ live_search_consent: true, google_backup_consent: true });
    Object.assign(cfg, settings);
    await finish(id);
    expect(relay.mock.calls[0][0]).not.toHaveProperty('google_backup_consent');
    expect(await read(id)).toMatchObject({ google_backup_consent: true, configured_google_backup_provider: 'serpapi' });
  });

  it('requires a matching saved provider snapshot even if a legacy record has a true permission flag', async () => {
    quota({ max: 1 }); cfg.google_backup_provider = 'serpapi'; cfg.google_backup_available = true;
    const id = await create({ live_search_consent: true, google_backup_consent: true });
    await store.update('scan', id, scan => ({ ...scan, configured_google_backup_provider: null }));
    await finish(id);
    expect(relay.mock.calls[0][0]).not.toHaveProperty('google_backup_consent');
  });

  it('audits recovered SerpApi backup separately from SearXNG Google retries and engine attribution', async () => {
    quota({ max: 1 }); cfg.google_backup_provider = 'serpapi'; cfg.google_backup_available = true;
    relay.mockResolvedValue({ results: [fixture()], related: [], coverage: { returned: 1, invalid: 0, limited: 0,
      engines: ['google cse', 'google'], attempts: 2, google_recovery: 'recovered', google_backup_provider: 'serpapi' } });
    const result = await finish(await create({ live_search_consent: true, google_backup_consent: true }));
    expect(result.coverage.diagnostics).toMatchObject({ attempts: 2, google_backup_attempts: 1,
      google_backup_recoveries: 1, google_backup_providers: ['serpapi'], retained: 1 });
    expect(result.coverage.diagnostics).not.toHaveProperty('google_retries');
    expect(result.coverage.diagnostics).not.toHaveProperty('google_recoveries');
    expect(result.search_engines).toEqual(['google cse']);
    expect(result.google_backup_providers).toEqual(['serpapi']);
    expect(result.usage.serp_queries).toBe(1);
  });

  it('aggregates successful, empty, failed and skipped backups while preserving separate SearXNG recovery counts', async () => {
    quota({ max: 6 }); cfg.google_backup_provider = 'serpapi'; cfg.google_backup_available = true;
    const statuses = ['recovered', 'empty', 'failed', 'budget_skipped', 'time_skipped'];
    relay.mockImplementation(async () => {
      const status = statuses.shift();
      return { results: [fixture()], related: [], coverage: { returned: 1, invalid: 0, limited: 0, engines: ['google cse'],
        attempts: !status || ['recovered', 'empty', 'failed'].includes(status) ? 2 : 1,
        google_recovery: status || 'recovered', ...(status ? { google_backup_provider: 'serpapi' } : {}) } };
    });
    const result = await finish(await create({ live_search_consent: true, google_backup_consent: true }));
    expect(result.coverage.diagnostics).toMatchObject({ attempts: 10, google_backup_attempts: 3, google_backup_recoveries: 1,
      google_backup_skips: 2, google_backup_providers: ['serpapi'], google_retries: 1, google_recoveries: 1 });
    expect(result.google_backup_providers).toEqual(['serpapi']);
  });

  it('never treats skipped or unsuccessful backup activity as an additional source with results', async () => {
    quota({ max: 1 });
    relay.mockResolvedValue({ results: [fixture()], related: [], coverage: { returned: 1, invalid: 0, limited: 0,
      engines: ['google cse'], attempts: 1, google_recovery: 'time_skipped', google_backup_provider: 'serpapi' } });
    const result = await finish(await create({ live_search_consent: true }));
    expect(result.coverage.diagnostics).toMatchObject({ google_backup_skips: 1, google_backup_providers: ['serpapi'] });
    expect(result.coverage.diagnostics).not.toHaveProperty('google_backup_attempts');
    expect(result.google_backup_providers).toEqual([]);
  });

  it('drops unsupported backup labels instead of misclassifying them as SearXNG-only retries', async () => {
    quota({ max: 1 });
    relay.mockResolvedValue({ results: [fixture()], related: [], coverage: { returned: 1, invalid: 0, limited: 0,
      engines: ['google cse'], attempts: 2, google_recovery: 'recovered', google_backup_provider: 'private-provider-secret' } });
    const result = await finish(await create({ live_search_consent: true }));
    expect(result.coverage.diagnostics).not.toHaveProperty('google_backup_providers');
    expect(result.coverage.diagnostics).not.toHaveProperty('google_retries');
    expect(result.google_backup_providers).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private-provider-secret');
  });

  it('records metered Google recovery responses separately from logical browser queries', async () => {
    quota({ max: 1 });
    relay.mockResolvedValue({ results: [fixture()], related: [], coverage: { returned: 1, invalid: 0, limited: 0,
      engines: ['google'], attempts: 2, google_recovery: 'recovered' } });
    const id = await create({ live_search_consent: true });
    const result = await finish(id);
    expect(result.usage.serp_queries).toBe(1);
    expect(result.coverage.diagnostics).toMatchObject({ attempts: 2, google_retries: 1, google_recoveries: 1, retained: 1 });
    expect(relay).toHaveBeenCalledOnce();
  });
  it('retains matching earlier findings without a search, changing original records or inventing fresh response counts', async () => {
    const earlier = await importedScan({}, [fixture('Anne Lee', 'https://publisher.example/one'), fixture('Anne Lee', 'https://publisher.example/two')]);
    await status(earlier, 1, 'sent');
    const original = await read(earlier);
    clock += 3000;
    quota({ max: 1 }); cfg.search_engines = ['google', 'bing', 'google cse'];
    const id = await create({ live_search_consent: true });
    expect(relay).not.toHaveBeenCalled(); expect(permit).not.toHaveBeenCalled();
    const created = await read(id);
    expect(created.hits).toHaveLength(2);
    expect(created.hits[0]).toMatchObject({ status: 'sent', discovery_origin: 'previous_scan', previous_scan_id: earlier,
      last_seen_at: NOW, previous_observed_at: NOW, carried_into_at: clock });
    expect(created.queries).toEqual([]); expect(created.drafts).toEqual([]); expect(created.serp_queries).toBe(0);
    relay.mockResolvedValue({ results: [], related: [], coverage: { returned: 0, engines: ['bing'] } });
    const result = await finish(id);
    expect(result.shown).toHaveLength(2);
    expect(result.configured_search_engines).toEqual(['google', 'bing', 'google cse']);
    expect(result.coverage).toMatchObject({ carried: 2, reviewable: 2, diagnostics: { returned: 0, retained: 0 } });
    expect(await read(earlier)).toEqual(original);
  });
  it('can restore a completed report locally, deduplicating known findings and keeping its search audit unchanged', async () => {
    const earlier = await importedScan({}, [fixture('Anne Lee', 'https://publisher.example/one'), fixture('Anne Lee', 'https://publisher.example/two')]);
    const original = await read(earlier);
    clock += 3000;
    const id = await create();
    // Model a report created before automatic history retention existed.
    await store.update('scan', id, row => ({ ...row, status: 'done', hits: [{ ...original.hits[0], id: 7, status: 'resolved' }],
      queries: [{ id: 1, q: 'Anne Lee', status: 'done', results: 1, coverage: { returned: 1, retained: 1, attempts: 1 } }], serp_queries: 1 }));
    const before = await read(id);
    expect(await handle(`${path(id)}/history`, { method: 'POST', body: {} })).toEqual({ carried_count: 1 });
    const saved = await read(id), result = await poll(id);
    expect(saved.hits.map(hit => hit.id)).toEqual([7, 8]);
    expect(saved.hits[0]).toEqual(before.hits[0]);
    expect(saved.queries).toEqual(before.queries); expect(saved.serp_queries).toBe(1);
    expect(result.coverage.carried).toBe(1); expect(result.coverage.diagnostics.retained).toBe(1);
    expect(await handle(`${path(id)}/history`, { method: 'POST', body: {} })).toEqual({ carried_count: 0 });
    expect(await read(earlier)).toEqual(original);
    expect(relay).not.toHaveBeenCalled(); expect(permit).not.toHaveBeenCalled();
  });
  it('marks a carried URL as returned again even when its metadata is identical, retaining its user status', async () => {
    const earlier = await importedScan(); await status(earlier, 1, 'sent');
    clock += 3000;
    const id = await importedScan();
    const saved = await read(id), result = await poll(id);
    expect(saved.hits).toHaveLength(1);
    expect(saved.hits[0]).toMatchObject({ discovery_origin: 'search', reobserved_at: clock, last_seen_at: clock,
      previous_scan_id: earlier, previous_observed_at: NOW, status: 'sent', created_at: NOW });
    expect(result.coverage.carried).toBe(0);
    expect(result.coverage.diagnostics).toMatchObject({ retained: 0, duplicates: 1 });
  });
  it('does not carry different identity context and rejects history updates during an active step or with extra payload', async () => {
    await importedScan(); clock += 3000;
    const id = await create({ context: { country_code: 'uk' } });
    expect((await read(id)).hits).toEqual([]);
    await expect(handle(`${path(id)}/history`, { method: 'POST', body: { url: 'https://unknown.example' } })).rejects.toMatchObject({ status: 400 });
    await store.update('scan', id, row => ({ ...row, lease_until: clock + 1000 }));
    await expect(handle(`${path(id)}/history`, { method: 'POST', body: {} })).rejects.toMatchObject({ status: 409 });
    expect(relay).not.toHaveBeenCalled(); expect(permit).not.toHaveBeenCalled();
  });
  it('elevates a neutral result from later matching concern metadata without adding a second URL', async () => {
    const url = 'https://publisher.example/opaque';
    const id = await importedScan({}, [{ url, title: 'Anne Lee profile', snippet: '' }]);
    const original = (await read(id)).hits[0];
    clock += 3000;
    const { query, response } = await importNextQuery(id, [fixture('Anne Lee', `${url}?utm_source=later`)]);
    const saved = await read(id), result = await poll(id);
    expect(response.imported).toBe(0);
    expect(saved.hits).toHaveLength(1);
    expect(saved.hits[0]).toMatchObject({ id: original.id, url: original.url, canonical_url: original.canonical_url,
      category: 'scam_fraud', source_query: original.source_query, created_at: original.created_at });
    expect(saved.hits[0].metadata_updates).toEqual([{ source_query: query.q, at: clock }]);
    expect(result.shown[0].category).toBe('scam_fraud');
    expect(result.coverage.diagnostics).toMatchObject({ returned: 2, duplicates: 1, retained: 1 });
    expect(result.shown[0]).not.toHaveProperty('metadata_updates');
  });
  it('enriches same-batch duplicates and keeps the stronger concern when another thin snippet follows', async () => {
    const url = 'https://publisher.example/opaque';
    const id = await importedScan({}, [
      { url, title: 'Anne Lee profile', snippet: '' },
      fixture('Anne Lee', url),
      { url, title: 'Anne Lee profile', snippet: '' },
    ]);
    const saved = await read(id), result = await poll(id);
    expect(saved.hits).toHaveLength(1);
    expect(saved.hits[0]).toMatchObject({ category: 'scam_fraud', title: 'Anne Lee scam allegation', snippet: 'Anne Lee fraud complaint Singapore' });
    expect(saved.hits[0].metadata_updates).toHaveLength(1);
    expect(result.coverage.diagnostics).toMatchObject({ returned: 3, duplicates: 2, retained: 1 });
  });
  it.each(['not_me', 'sent', 'resolved', 'removed', 'refused', 'escalated'])('preserves %s tracking, history and saved drafts during duplicate enrichment', async tracked => {
    const url = 'https://publisher.example/opaque';
    const id = await importedScan({}, [{ url, title: 'Anne Lee profile', snippet: '' }]);
    const hit = (await read(id)).hits[0];
    await draft(id, hit.id, { template: 'copyright', owns_content: true });
    await status(id, hit.id, tracked);
    const before = await read(id);
    clock += 3000;
    await importNextQuery(id, [fixture('Anne Lee', url)]);
    const after = await read(id);
    expect(after.hits[0]).toMatchObject({ id: hit.id, status: tracked, category: 'scam_fraud', created_at: before.hits[0].created_at,
      history: before.hits[0].history, source_query: before.hits[0].source_query, canonical_url: before.hits[0].canonical_url });
    expect(after.drafts).toEqual(before.drafts);
    if (tracked === 'not_me') expect((await poll(id)).shown).toHaveLength(0);
  });
  it('fills missing context from a matching duplicate and rejects unrelated-name metadata at the same URL', async () => {
    const url = 'https://publisher.example/opaque';
    const id = await importedScan({}, [{ url, title: 'Anne Lee profile', snippet: '' }]);
    await importNextQuery(id, [{ url, title: 'Someone else fraud allegation', snippet: 'Singapore' }]);
    expect((await read(id)).hits[0]).toMatchObject({ category: 'neutral', snippet: '', match_confidence: 0.4 });
    await importNextQuery(id, [{ url, title: 'Anne Lee personal profile', snippet: 'Anne Lee Singapore public profile' }]);
    const refreshed = (await read(id)).hits[0];
    expect(refreshed).toMatchObject({ category: 'neutral', title: 'Anne Lee profile', snippet: 'Anne Lee Singapore public profile' });
    expect(refreshed.match_confidence).toBeCloseTo(0.6);
  });
  it.each([
    { title: `${'x'.repeat(350)} Anne Lee fraud allegation`, snippet: '' },
    { title: 'Public mention', snippet: `${'x'.repeat(1100)} Anne Lee fraud allegation` },
  ])('matches and classifies name metadata beyond the former early clipping boundary: %j', async metadata => {
    quota({ max: 1 });
    relay.mockResolvedValue({ results: [{ ...metadata, url: 'https://publisher.example/opaque' }], related: [] });
    const result = await finish(await create({ live_search_consent: true }));
    expect(result.shown).toHaveLength(1);
    expect(result.shown[0].category).toBe('scam_fraud');
    expect(result.coverage.diagnostics).toMatchObject({ no_name: 0, retained: 1 });
  });
  it('keeps an earlier concern when later metadata contains only an ordinary match', async () => {
    const id = await importedScan(), before = (await read(id)).hits[0];
    await importNextQuery(id, [{ url: before.url, title: 'Anne Lee profile', snippet: 'Public profile' }]);
    expect((await read(id)).hits[0]).toEqual(before);
  });
  it('guards a later sensitive observation and never re-exposes it through ordinary duplicates', async () => {
    const url = 'https://publisher.example/opaque';
    const id = await importedScan({}, [{ url, title: 'Anne Lee profile', snippet: '' }]);
    const original = (await read(id)).hits[0];
    await status(id, original.id, 'sent');
    await importNextQuery(id, [{ url, title: 'Intimate images', snippet: 'Private material' }]);
    const guarded = (await read(id)).hits[0];
    expect(guarded).toMatchObject({ id: original.id, status: 'sent', category: 'sensitive_intimate', title: 'Sensitive result — support available', snippet: '' });
    await importNextQuery(id, [fixture('Anne Lee', url)]);
    expect((await read(id)).hits[0]).toEqual(guarded);
    const result = await poll(id);
    expect(result.shown).toHaveLength(0);
    expect(result.extra).toHaveLength(0);
    expect(result.helpRequired).toBe(true);
    expect(result.coverage).toMatchObject({ sensitive: 1, retained: 1 });
    await expect(handle(`${path(id)}/attachment`, { body: { hit_ids: [original.id] } })).rejects.toMatchObject({ status: 400 });
  });
  it('guards a same-batch sensitive duplicate before the initial ordinary row can be displayed', async () => {
    const url = 'https://publisher.example/opaque';
    const id = await importedScan({}, [
      { url, title: 'Anne Lee profile', snippet: '' },
      { url, title: 'Anne Lee intimate images', snippet: 'Private material' },
      fixture('Anne Lee', url),
    ]);
    const result = await poll(id);
    expect(result.shown).toHaveLength(0);
    expect(result.coverage.diagnostics).toMatchObject({ returned: 3, duplicates: 2, retained: 1 });
    expect((await read(id)).hits[0].category).toBe('sensitive_intimate');
  });
  it('reserves all eight reputation queries even when aliases and handles are supplied', async () => {
    quota();
    const id = await create({live_search_consent:true, variants:['Anna Lee','Annie Lee','Anne Lim'],
      context:{usernames:['annelee1','annelee2','annelee3']}});
    await finish(id);
    expect((await read(id)).queries.filter(query=>query.source==='reputation')).toHaveLength(8);
    expect(relay.mock.calls.filter(([payload])=>payload.page===2)).toHaveLength(2);
  });
  it('retains a matching result after position twenty and records why other results were discarded', async () => {
    quota({max:1});
    const items = [...Array.from({length:23}, (_,i)=>({title:'Unrelated name',url:`https://publisher.example/other/${i}`,snippet:''})),
      fixture(), fixture()];
    relay.mockResolvedValue({results:items, related:[], coverage:{returned:28,invalid:3,limited:0,engines:['google cse','private-provider-secret']}});
    const id = await create({live_search_consent:true}), result = await finish(id);
    expect(result.shown.map(hit=>hit.url)).toEqual(['https://news.example/story']);
    expect(result.search_engines).toEqual(['google cse']);
    expect(result.coverage.diagnostics).toEqual({complete:true,tracked_queries:1,returned:28,invalid:3,limited:0,
      no_name:23,duplicates:1,retained:1,attempts:1});
    expect(JSON.stringify(result)).not.toContain('private-provider-secret');
  });
  it('bounds a web response at one hundred while retaining the first-ten display limit', async () => {
    quota({max:1});
    relay.mockResolvedValue({results:Array.from({length:101}, (_,i)=>fixture('Anne Lee',`https://publisher.example/${i}`)),related:[]});
    const result = await finish(await create({live_search_consent:true}));
    expect(result.coverage.retained).toBe(100);
    expect(result.coverage.diagnostics).toMatchObject({returned:101,limited:1,retained:100});
    expect(result.shown).toHaveLength(10);
    expect(result.moreCount).toBe(90);
  });
  it('does not fabricate provider or filtering diagnostics for historical scans', async () => {
    quota({max:1});
    const id = await create({live_search_consent:true}); await finish(id);
    await store.update('scan',id,scan=>({...scan,queries:scan.queries.map(({coverage,...query})=>query)}));
    expect((await poll(id)).coverage.diagnostics).toMatchObject({complete:false,tracked_queries:0});
  });
  it('counts partial retries separately without counting a repeated URL as a new result', async () => {
    quota({max:1});
    relay.mockResolvedValueOnce({results:[fixture()],related:[],partial:true,coverage:{returned:1,invalid:0,limited:0,engines:['google cse']}})
      .mockResolvedValueOnce({results:[fixture()],related:[],coverage:{returned:1,invalid:0,limited:0,engines:['google cse']}});
    const id = await create({live_search_consent:true});
    expect((await finish(id)).partial).toBe(true);
    await handle(`${path(id)}/retry`, {method:'POST'});
    const result = await finish(id);
    expect(result.coverage.diagnostics).toMatchObject({returned:2,duplicates:1,retained:1,attempts:2});
    expect(result.shown).toHaveLength(1);
  });
  it('fits broad name pages and the eight reputation keyword searches in twelve SearXNG requests',async()=>{
    cfg={...cfg,provider:'searxng',search_relay_enabled:true,max_queries:12};
    const id=await create({live_search_consent:true});
    await finish(id);
    const saved=await read(id);
    expect(saved.queries.filter(query=>query.source==='reputation')).toHaveLength(8);
    expect(saved.serp_queries).toBe(12);
    expect(relay.mock.calls.filter(([payload])=>payload.page===2)).toHaveLength(2);
    expect(saved.queries.some(query=>query.q==='"Anne Lee" scandal')).toBe(true);
  });
  it('uses second pages for broad SearXNG name searches within the existing four-request allowance',async()=>{
    cfg={...cfg,provider:'searxng',search_relay_enabled:true,max_queries:4};
    const id=await create({live_search_consent:true});
    const result=await finish(id);
    expect(result.usage.serp_queries).toBe(4);
    expect(relay.mock.calls.map(([payload])=>[payload.q,payload.page||1])).toEqual([
      ['"Anne Lee"',1],['Anne Lee',1],['"Anne Lee"',2],['Anne Lee',2],
    ]);
    expect(result.progress).toMatchObject({total:4,completed:4});
    expect((await read(id)).queries.map(query=>query.status)).toEqual(['done','done','done','done']);
  });
  it('retains more than three distinct pages per domain and includes ordinary matches in the ten-link preview', async () => {
    cfg.max_queries = 1;
    const items = Array.from({ length: 17 }, (_, i) => ({ title: `Anne Lee profile ${i}`, snippet: 'A name match for review', url: `https://profiles.example/person/${i}` }));
    items.push(fixture('Anne Lee', 'https://profiles.example/complaint'));
    items.push({title:'Anne Lee professional profile',snippet:'Work profile',url:'https://sg.linkedin.com/in/anne-lee'});
    items.push({title:'Anne Lee business directory',snippet:'Business contacts',url:'https://rocketreach.co/anne-lee'});
    const id = await importedScan({}, items);
    const result = await poll(id);
    expect(result.shown).toHaveLength(10);
    expect(result.shown[0].category).toBe('scam_fraud');
    expect(result.moreCount).toBe(8);
    expect(result.extra).toHaveLength(8);
    expect(result.coverage).toMatchObject({retained:20,reviewable:18,flagged:1,ordinary:17,professional:2,sensitive:0});
    expect((await handle(`${path(id)}/attachment`)).results).toEqual(result.shown.map(({url,title})=>({url,title})));
    expect((await read(id)).hits).toHaveLength(20);
    expect(relay).not.toHaveBeenCalled();
  });

  it('uses a validated user contact email in local drafts and preserves an edited draft for the same email', async () => {
    const id = await create(), report = await finish(id), hit = report.shown[0];
    const info = await draft(id, hit.id, {});
    const template = info.templates[0].id;
    const body = { template, sender_email: 'my-account@example.test' };
    const first = await draft(id, hit.id, body);
    expect(first.draft.body).toContain('Contact: my-account@example.test');
    expect(first.draft.sender_email).toBe(body.sender_email);
    await handle(`/api/hit/${hit.id}/draft`, { method: 'PATCH', scanId: id, body: { draft_id: first.draft.id, subject: first.draft.subject, body: 'My reviewed request' } });
    expect((await draft(id, hit.id, body)).draft.body).toBe('My reviewed request');
    const changed = await draft(id, hit.id, { template, sender_email: 'different@example.test' });
    expect(changed.draft.body).toContain('Contact: different@example.test');
    const preview = await draft(id, hit.id, { template, sender_email: '' });
    expect(preview.draft.sender_email).toBe('');
    expect(preview.draft.body).toContain('Contact: [Your contact email]');
    expect(preview.draft.body).not.toContain('different@example.test');
    for (const sender_email of ['invalid', 'a@example.test\r\nBcc: other@example.test']) {
      await expect(draft(id, hit.id, { template, sender_email })).rejects.toMatchObject({ status: 400 });
    }
    expect(relay).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('runs a complete mock scan with local full results and no relay, AI, page reads or identity reuse', async () => {
    const id = await create(), second = await create();
    expect(id).not.toBe(second);
    const report = await finish(id);
    expect(report).toMatchObject({ id, status: 'done', full_name: 'Anne Lee', subject_type: 'person', provider: 'mock', is_minor: false });
    expect(report.shown).toHaveLength(10);
    expect(report.extra.length).toBeGreaterThan(0);
    expect(report.extra).toHaveLength(report.moreCount);
    expect(new Set([...report.shown, ...report.extra].map(hit => hit.id)).size).toBe(report.shown.length + report.extra.length);
    expect(report.progress.completed).toBe(report.progress.total);
    expect(report.usage.serp_queries).toBe(0);
    expect((await read(id)).hits.every(hit => hit.fetch_state === 'skipped')).toBe(true);
    expect([...store.records.keys()].every(key => key.startsWith('scan:'))).toBe(true);
    expect(relay).not.toHaveBeenCalled();
  });

  it.each(['sensitive_intimate', 'child_safety'])('routes %s directly to help before configuration or storage', async harm => {
    const result = await handle('/api/scan', { method: 'POST', body: { ...base, harm_types: [harm] } });
    expect(result).toEqual({ id: null, help_only: true, show_help_first: true });
    expect(config).not.toHaveBeenCalled(); expect(relay).not.toHaveBeenCalled(); expect(store.put).not.toHaveBeenCalled();
  });

  it.each([
    { attestation: false }, { is_minor: 'false' }, { full_name: 'A' }, { subject_type: 'unknown' }, { subject_type: null },
    { context: { country_code: 'unknown' } }, { context: { country: 'imaginary' } }, { email: 'bad' },
    { subject_type: 'business', context: { representative_name: '' } }, { subject_type: 'business', is_minor: true },
    { subject_type: 'business', context: { representative_name: 'Ari Tan', website: 'http://127.0.0.1/private' } },
  ])('validates scan declarations and fields before storing: %j', async invalid => {
    await expect(create(invalid)).rejects.toMatchObject({ status: 400 });
    expect(store.put).not.toHaveBeenCalled(); expect(config).not.toHaveBeenCalled();
  });

  it.each(['serpapi', 'searxng'])('requires both an enabled relay and explicit sharing consent before creating %s scans', async provider => {
    cfg.provider = provider;
    await expect(create({ live_search_consent: true })).rejects.toMatchObject({ status: 503 });
    cfg.search_relay_enabled = true;
    for (const live_search_consent of [undefined, false, 'true']) {
      await expect(create({ live_search_consent })).rejects.toMatchObject({ status: 403 });
    }
    expect(store.put).not.toHaveBeenCalled(); expect(relay).not.toHaveBeenCalled();
    expect(await create({ live_search_consent: true })).toBeTypeOf('string');
  });

  it('passes only queries, selected geography and kind to the relay, never local IDs or contact details', async () => {
    live();
    const id = await create({ ...business, live_search_consent: true });
    await poll(id); await poll(id);
    expect(relay).toHaveBeenCalledTimes(5);
    for (const [payload] of relay.mock.calls) {
      expect(Object.keys(payload).sort()).toEqual(['country_code', 'kind', 'q']);
      expect(payload.country_code).toBe('uk');
      expect(['search', 'autocomplete']).toContain(payload.kind);
      expect(JSON.stringify(payload)).not.toMatch(/Private Representative|private@acme|12345678|private=discard/);
    }
    expect((await read(id)).context.website).toBe('https://acme.example');
    expect((await read(id)).serp_queries).toBe(5);
  });

  it('preserves explicit no preference and normalises GB to the Google UK code', async () => {
    live(1);
    for (const [country_code, expected] of [['', ''], ['GB', 'uk']]) {
      const id = await create({ context: { country_code }, live_search_consent: true });
      relay.mockClear(); await finish(id);
      expect(relay.mock.calls.every(([payload]) => payload.country_code === expected)).toBe(true);
    }
  });

  it('keeps SearXNG country context local and skips autocomplete even without capability metadata', async () => {
    cfg = { ...cfg, provider: 'searxng', search_relay_enabled: true, max_queries: 60 };
    const id = await create({ ...business, live_search_consent: true });
    const planned = await poll(id);
    expect(planned).toMatchObject({ status: 'searching', country: 'United Kingdom', search_country_supported: false, autocomplete_supported: false });
    expect(relay).not.toHaveBeenCalled();
    const saved = await read(id);
    expect(saved.context).toMatchObject({ country_code: 'uk', country: 'United Kingdom' });
    expect(saved.queries.some(query => query.q.includes('United Kingdom'))).toBe(false);
    await poll(id);
    expect(relay).toHaveBeenCalledTimes(3);
    for (const [payload] of relay.mock.calls) {
      expect(Object.keys(payload).sort()).toEqual(['country_code', 'kind', ...(payload.page ? ['page'] : []), 'q']);
      expect(payload).toMatchObject({ country_code: '', kind: 'search' });
      expect(JSON.stringify(payload)).not.toMatch(/Private Representative|private@acme|12345678|United Kingdom/);
    }
  });

  it('honours disabled search capabilities for other providers without losing local country context', async () => {
    live(1); cfg.autocomplete_supported = false; cfg.search_country_supported = false;
    const id = await create({ live_search_consent: true });
    const report = await finish(id);
    expect(report).toMatchObject({ status: 'done', country: 'Singapore', autocomplete_supported: false, search_country_supported: false });
    expect(relay).toHaveBeenCalledOnce();
    expect(relay.mock.calls[0][0]).toMatchObject({ country_code: '', kind: 'search' });
  });

  it('retains partial SearXNG results as incomplete and retries only unfinished queries', async () => {
    cfg = { ...cfg, provider: 'searxng', search_relay_enabled: true, max_queries: 3 };
    const id = await create({ live_search_consent: true });
    await poll(id);
    relay.mockImplementation(async ({ page }) => ({ results: [fixture()], related: [], partial: page === 2 }));
    const incomplete = await poll(id);
    expect(incomplete).toMatchObject({ status: 'error', partial: true, progress: { completed: 2, total: 3 } });
    expect(incomplete.error).toContain('incomplete');
    expect(incomplete.shown).toHaveLength(1);
    const saved = await read(id);
    expect(saved.queries.filter(query => query.status === 'pending')).toHaveLength(1);
    expect(saved.lease_until).toBe(0);
    await status(id, incomplete.shown[0].id, 'sent');
    await handle(`${path(id)}/retry`, { method: 'POST' });
    relay.mockClear(); relay.mockResolvedValue({ results: [fixture()], related: [] });
    const complete = await poll(id);
    expect(complete).toMatchObject({ status: 'done', partial: false, error: null, progress: { completed: 3, total: 3 } });
    expect(relay).toHaveBeenCalledOnce();
    expect(complete.shown).toHaveLength(1);
    expect(complete.shown[0].status).toBe('sent');
  });

  it('does not treat failed empty SearXNG searches as a completed scan without mentions', async () => {
    cfg = { ...cfg, provider: 'searxng', search_relay_enabled: true, max_queries: 1 };
    const id = await create({ live_search_consent: true });
    await poll(id);
    relay.mockRejectedValue(Object.assign(new Error('private upstream response'), { status: 502 }));
    const failed = await poll(id);
    expect(failed).toMatchObject({ status: 'error', shown: [], progress: { completed: 0, total: 1 } });
    expect(failed.error).not.toContain('private upstream response');
    expect((await read(id)).queries[0].status).toBe('pending');
  });

  it('rechecks relay enablement before polling a previously authorised scan', async () => {
    live(); const id = await create({ live_search_consent: true }); cfg.search_relay_enabled = false;
    expect((await poll(id)).status).toBe('error');
    expect(relay).not.toHaveBeenCalled();
    expect((await read(id)).lease_until).toBe(0);
  });

  it('gets one public permit lazily and reuses it across batches and a browser service reload', async () => {
    quota({ max: 6 });
    const id = await create({ ...business, live_search_consent: true });
    expect(permit).not.toHaveBeenCalled();
    await poll(id);
    expect(permit).not.toHaveBeenCalled(); expect(relay).not.toHaveBeenCalled();
    const first = await poll(id);
    expect(permit).toHaveBeenCalledOnce();
    const nonce = permit.mock.calls[0][0].request_id;
    expect(nonce).not.toBe(id);
    expect(Object.keys(permit.mock.calls[0][0])).toEqual(['request_id']);
    expect(first.allowance).toMatchObject({ operator: false, remaining_scans: 2, reset_at: permitResult().reset_at });
    for (const [payload] of relay.mock.calls) {
      expect(Object.keys(payload).sort()).toEqual(['country_code', 'kind', ...(payload.page ? ['page'] : []), 'q', 'search_ticket']);
      expect(payload.search_ticket).toBe(permitResult().search_ticket);
      expect(JSON.stringify(payload)).not.toMatch(/Private Representative|private@acme|12345678/);
    }
    expect(JSON.stringify(first)).not.toContain(nonce);
    expect(JSON.stringify(first)).not.toContain(permitResult().search_ticket);
    handle = createBrowserScans({ store, config, relay, permit, now: () => clock });
    expect((await poll(id)).status).toBe('done');
    expect(permit).toHaveBeenCalledOnce();
  });

  it('serialises permit acquisition under the scan lease across tabs', async () => {
    quota({ max: 1 }); const id = await create({ live_search_consent: true }); await poll(id);
    const started = deferred(), response = deferred();
    permit.mockImplementation(() => { started.resolve(); return response.promise; });
    const running = poll(id); await started.promise;
    const otherTab = createBrowserScans({ store, config, relay, permit, now: () => clock });
    expect((await otherTab(path(id))).status).toBe('searching');
    expect(permit).toHaveBeenCalledOnce(); expect(relay).not.toHaveBeenCalled();
    response.resolve(permitResult());
    expect((await running).status).toBe('done');
    expect(relay).toHaveBeenCalledOnce();
  });

  it.each([{ operator: false, expected: 2 }, { operator: true, expected: 3 }])('limits protected scan concurrency and completes all work: %j', async ({ operator, expected }) => {
    quota({ operator, max: 5 }); cfg.abuse_protection_enabled = true;
    let active = 0, maximum = 0;
    relay.mockImplementation(async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 0));
      active--;
      return { results: [fixture()], related: [] };
    });
    const id = await create({ live_search_consent: true });
    const result = await finish(id);
    expect(maximum).toBe(expected);
    expect(active).toBe(0);
    expect(result).toMatchObject({ status: 'done', progress: { completed: 5, total: 5 } });
    expect(relay).toHaveBeenCalledTimes(5);
    expect(permit).toHaveBeenCalledOnce();
  });

  it('cannot recreate a deleted scan or search after an in-flight permit returns', async () => {
    quota({ max: 1 }); const id = await create({ live_search_consent: true }); await poll(id);
    const started = deferred(), response = deferred();
    permit.mockImplementation(() => { started.resolve(); return response.promise; });
    const running = poll(id), rejection = expect(running).rejects.toMatchObject({ status: 404 }); await started.promise;
    await handle(path(id), { method: 'DELETE' });
    response.resolve(permitResult()); await rejection;
    expect(await read(id)).toBeUndefined(); expect(relay).not.toHaveBeenCalled(); expect(store.put).toHaveBeenCalledOnce();
  });

  it('reuses the persisted idempotency nonce after a lost permit response', async () => {
    quota({ max: 1 }); const id = await create({ live_search_consent: true }); await poll(id);
    permit.mockRejectedValueOnce(Object.assign(new Error('response lost'), { status: 504 }));
    expect((await poll(id)).status).toBe('error');
    expect(relay).not.toHaveBeenCalled();
    await handle(`${path(id)}/retry`, { method: 'POST' });
    expect((await poll(id)).status).toBe('done');
    expect(permit).toHaveBeenCalledTimes(2);
    expect(permit.mock.calls[0][0]).toEqual(permit.mock.calls[1][0]);
  });

  it('reuses a permit on retry and obtains a new nonce only after expiry', async () => {
    quota({ max: 6 }); const id = await create({ live_search_consent: true }); await poll(id);
    relay.mockRejectedValueOnce(Object.assign(new Error('temporary provider error'), { status: 502 }));
    expect((await poll(id)).status).toBe('error');
    await handle(`${path(id)}/retry`, { method: 'POST' });
    expect((await poll(id)).status).toBe('searching');
    expect(permit).toHaveBeenCalledOnce();
    clock = permitResult().expires_at + 1;
    expect((await poll(id)).status).toBe('done');
    expect(permit).toHaveBeenCalledTimes(2);
    expect(permit.mock.calls[0][0].request_id).not.toBe(permit.mock.calls[1][0].request_id);
    expect(relay.mock.calls.at(-1)[0].search_ticket).toBe(permitResult().search_ticket);
  });

  it('preserves pending work on public quota rejection without sending search queries', async () => {
    quota({ max: 1 }); const id = await create({ live_search_consent: true }); await poll(id);
    permit.mockRejectedValue(Object.assign(new Error('untrusted quota detail'), { status: 429, code: 'scan_limit_reached', reset_at: permitResult().reset_at }));
    const paused = await poll(id);
    expect(paused).toMatchObject({ status: 'paused_budget', error_code: 'scan_limit_reached', progress: { completed: 0, total: 1 } });
    expect(paused.error).toContain('00:00 UTC'); expect(paused.error).not.toContain('untrusted quota detail');
    expect(paused.allowance.reset_at).toBe(permitResult().reset_at);
    expect(relay).not.toHaveBeenCalled(); expect(paused.usage.serp_queries).toBe(0);
    expect((await read(id)).queries[0].status).toBe('pending');
  });

  it('shows a bounded cooldown message and preserves the uncharged scan for retry', async () => {
    quota({ max: 1 }); const id = await create({ live_search_consent: true }); await poll(id);
    permit.mockRejectedValue(Object.assign(new Error('private server detail'), { status: 429, code: 'scan_cooldown', retry_after_seconds: 42, reset_at: clock + 42000 }));
    const paused = await poll(id);
    expect(paused).toMatchObject({ status: 'paused_budget', error_code: 'scan_cooldown', progress: { completed: 0, total: 1 } });
    expect(paused.error).toContain('42 seconds'); expect(paused.error).not.toContain('private server detail');
    expect(relay).not.toHaveBeenCalled();
  });

  it('uses operator permits without a daily remaining count and blocks a larger scan after logout', async () => {
    quota({ operator: true, max: 60 }); const id = await create({ live_search_consent: true }); await poll(id);
    const active = await poll(id);
    expect(active.allowance).toMatchObject({ operator: true, remaining_scans: null });
    expect(permit).toHaveBeenCalledOnce();
    const before = await read(id); cfg = { ...cfg, operator: false, max_queries: 12 };
    relay.mockClear(); permit.mockClear();
    const paused = await poll(id);
    expect(paused).toMatchObject({ status: 'error', error_code: 'operator_sign_in_required' });
    expect(paused.error).toContain('Sign in');
    expect(paused.shown).toEqual(active.shown);
    expect((await read(id)).queries).toEqual(before.queries);
    expect(relay).not.toHaveBeenCalled(); expect(permit).not.toHaveBeenCalled();
  });

  it('replaces an operator permit after logout when the saved scan fits the public limit', async () => {
    quota({ operator: true, max: 6 }); const id = await create({ live_search_consent: true }); await poll(id); await poll(id);
    const oldNonce = permit.mock.calls[0][0].request_id;
    cfg = { ...cfg, operator: false, max_queries: 12 };
    expect((await poll(id)).status).toBe('done');
    expect(permit).toHaveBeenCalledTimes(2);
    expect(permit.mock.calls[1][0].request_id).not.toBe(oldNonce);
    expect((await read(id)).search_permit.operator).toBe(false);
  });

  it('does not replace exhausted tickets with another paid daily slot before expiry', async () => {
    quota({ max: 1 }); const id = await create({ live_search_consent: true }); await poll(id);
    relay.mockRejectedValue(Object.assign(new Error('quota response'), { status: 429, code: 'search_ticket_exhausted', reset_at: permitResult().reset_at }));
    expect((await poll(id)).error_code).toBe('search_ticket_exhausted');
    await handle(`${path(id)}/retry`, { method: 'POST' });
    const retry = await poll(id);
    expect(retry.status).toBe('paused_budget'); expect(retry.error).toContain('new daily scan slot');
    expect(permit).toHaveBeenCalledOnce();
  });

  it('filters sensitive queries and hides sensitive result titles, snippets and URLs from reports and attachments', async () => {
    live(60);
    relay.mockImplementation(async ({ kind }) => kind === 'autocomplete'
      ? { suggestions: ['Anne Lee nudes', 'Anne Lee scam'] }
      : { results: [fixture(), { title: 'Anne Lee leaked intimate images', snippet: 'private material', url: 'https://example.com/intimate-images/anne-lee' }], related: ['Anne Lee porn', 'Anne Lee court'] });
    const id = await create({ live_search_consent: true, variants: ['Anne Lee naked'], context: { employer: 'intimate images', usernames: ['anneleescam'] } });
    const report = await finish(id);
    expect(report.helpRequired).toBe(true);
    expect(JSON.stringify([...report.shown, ...report.extra, ...report.sameName, ...report.notMe])).not.toMatch(/intimate-images|private material|leaked intimate/);
    expect(relay.mock.calls.every(([payload]) => !/nudes|naked|porn|intimate images/.test(payload.q))).toBe(true);
    const guarded = (await read(id)).hits.find(hit => hit.category === 'sensitive_intimate');
    expect(guarded.snippet).toBe('');
    expect(await draft(id, guarded.id, { template: 'copyright', owns_content: true })).toMatchObject({ help_only: true, templates: [], draft: null });
    await expect(handle(`${path(id)}/attachment`, { body: { hit_ids: [guarded.id] } })).rejects.toMatchObject({ status: 400 });
  });

  it('recognises full-width and zero-width sensitive text in queries and imported labels or URLs', async () => {
    const guarded = await handle('/api/scan', { method: 'POST', body: { ...base, full_name: 'Anne Lee ｎｕｄｅｓ' } });
    expect(guarded.help_only).toBe(true); expect(config).not.toHaveBeenCalled();
    const id = await importedScan({}, [
      { title: 'Anne Lee on only\u200bfans', snippet: '', url: 'https://example.com/a' },
      { title: 'Anne Lee profile', snippet: '', url: 'https://example.com/%EF%BD%8E%EF%BD%95%EF%BD%84%EF%BD%85%EF%BD%93' },
    ]);
    expect((await read(id)).hits.every(hit => hit.category === 'sensitive_intimate')).toBe(true);
    expect((await poll(id)).shown).toEqual([]);
  });

  it('prepares local person and business drafts, with no invented host contacts and explicit ownership', async () => {
    const id = await importedScan({}, [fixture()]), hit = (await read(id)).hits[0];
    const plain = await draft(id, hit.id, { template: 'inaccurate' });
    expect(plain).toMatchObject({ channel: null, abuse: null, draft: { source: 'template' } });
    expect(plain.draft.body).toContain('anne@example.com');
    expect((await read(id)).drafts).toHaveLength(1);
    const businessId = await importedScan(business, [fixture('Acme Studio')]), businessHit = (await read(businessId)).hits[0];
    const letter = await draft(businessId, businessHit.id, { template: 'inaccurate' });
    expect(letter.draft.body).toContain('Private Representative\nOn behalf of Acme Studio');
    await expect(draft(businessId, businessHit.id, { template: 'copyright' })).rejects.toMatchObject({ status: 400 });
    const copyright = await draft(businessId, businessHit.id, { template: 'copyright', owns_content: true });
    expect(copyright.draft.body).toContain('Acme Studio owns the work');
    expect(relay).not.toHaveBeenCalled();
  });

  it('keeps minor copyright and business personal-information templates unavailable', async () => {
    const id = await importedScan({ is_minor: true });
    expect((await draft(id, 1, { owns_content: true })).templates.map(template => template.id)).not.toContain('copyright');
    await expect(draft(id, 1, { template: 'copyright', owns_content: true })).rejects.toMatchObject({ status: 400 });
    const businessId = await importedScan(business, [{ title: 'Acme Studio owner home address NRIC', snippet: '', url: 'https://directory.example/post' }]);
    expect((await draft(businessId, 1, {})).templates.map(template => template.id)).not.toContain('personal_info');
    await expect(draft(businessId, 1, { template: 'personal_info' })).rejects.toMatchObject({ status: 400 });
  });

  it('saves edited drafts locally and returns the edits on discovery and repeated same-template generation', async () => {
    const id = await importedScan();
    const generated = await draft(id, 1, { template: 'inaccurate' });
    const edit = { subject: 'My corrected subject', body: 'My reviewed request text.', draft_id: generated.draft.id };
    expect(await handle('/api/hit/1/draft', { method: 'PATCH', scanId: id, body: edit })).toMatchObject({ ok: true, draft: { subject: edit.subject, body: edit.body } });
    const reopened = await draft(id, 1, {});
    expect(reopened.saved_draft).toMatchObject({ subject: edit.subject, body: edit.body, template: 'inaccurate', owns_content: false });
    expect((await draft(id, 1, { template: 'inaccurate' })).draft).toMatchObject({ id: generated.draft.id, subject: edit.subject, body: edit.body });
    expect((await read(id)).drafts).toHaveLength(1);
    expect(relay).not.toHaveBeenCalled();
  });

  it('keeps ownership-specific drafts separate and hides saved drafts when their template becomes ineligible', async () => {
    const id = await importedScan({ context: {} });
    const copyright = await draft(id, 1, { template: 'copyright', owns_content: true });
    expect((await draft(id, 1, { owns_content: false })).saved_draft).toBeNull();
    expect((await draft(id, 1, { owns_content: true })).saved_draft.id).toBe(copyright.draft.id);
    await status(id, 1, 'not_me');
    const clarification = await draft(id, 1, { template: 'same_name' });
    expect((await draft(id, 1, {})).saved_draft.id).toBe(clarification.draft.id);
    await status(id, 1, 'resolved');
    expect((await draft(id, 1, {})).saved_draft).toBeNull();
    await expect(handle('/api/hit/1/draft', { method: 'PATCH', scanId: id, body: { draft_id: clarification.draft.id, subject: 'Edited', body: 'Edited' } })).rejects.toMatchObject({ status: 400 });
  });

  it('targets the selected draft ID across tabs instead of overwriting a newer different template', async () => {
    const id = await importedScan();
    const first = await draft(id, 1, { template: 'inaccurate' });
    const second = await draft(id, 1, { template: 'copyright', owns_content: true });
    await handle('/api/hit/1/draft', { method: 'PATCH', scanId: id, body: { draft_id: first.draft.id, subject: 'Tab one', body: 'Saved for the first draft.' } });
    expect((await draft(id, 1, { template: 'copyright', owns_content: true })).draft).toEqual(second.draft);
    expect((await draft(id, 1, { template: 'inaccurate' })).draft.subject).toBe('Tab one');
    // A caller without draft_id updates the most recently selected draft.
    await handle('/api/hit/1/draft', { method: 'PATCH', scanId: id, body: { subject: 'Selected again', body: 'Selection stays local.' } });
    expect((await draft(id, 1, { template: 'inaccurate' })).draft.subject).toBe('Selected again');
    expect((await draft(id, 1, { template: 'copyright', owns_content: true })).draft).toEqual(second.draft);
  });

  it('requires an existing generated draft, bounds edits, and cannot save into a deleted scan', async () => {
    const id = await importedScan();
    const save = body => handle('/api/hit/1/draft', { method: 'PATCH', scanId: id, body });
    await expect(save({ subject: 'New', body: 'Ungenerated' })).rejects.toMatchObject({ status: 404 });
    const generated = await draft(id, 1, { template: 'inaccurate' });
    for (const body of [{ subject: 'x'.repeat(181), body: 'Body' }, { subject: 'Subject', body: 'x'.repeat(20001) }, { subject: 'Two\nlines', body: 'Body' }, { subject: null, body: 'Body' }]) {
      await expect(save(body)).rejects.toMatchObject({ status: 400 });
    }
    await expect(save({ subject: 'Subject', body: 'Body', draft_id: generated.draft.id + 1 })).rejects.toMatchObject({ status: 404 });
    expect((await read(id)).drafts[0].subject).toBe(generated.draft.subject);
    await handle(path(id), { method: 'DELETE' });
    await expect(save({ subject: 'Subject', body: 'Body' })).rejects.toMatchObject({ status: 404 });
    expect(await read(id)).toBeUndefined();
  });

  it('scopes result statuses to the local scan and gates same-name drafts on Not me', async () => {
    const id = await importedScan({ context: {} }), second = await create();
    await expect(status(second, 1, 'not_me')).rejects.toMatchObject({ status: 404 });
    await expect(draft(id, 1, { template: 'same_name' })).rejects.toMatchObject({ status: 400 });
    await status(id, 1, 'not_me');
    expect((await draft(id, 1, { template: 'same_name' })).draft.body).toContain('not the person');
    await expect(status(id, 1, 'invented')).rejects.toMatchObject({ status: 400 });
    expect((await poll(id)).notMe).toHaveLength(1);
  });

  it('allows attachments only as read-only previews with at most twenty selected local non-sensitive results', async () => {
    const id = await create();
    config.mockClear(); relay.mockClear();
    expect(await handle(`${path(id)}/attachment`)).toEqual({ subject_name: 'Anne Lee', subject_type: 'person', country: 'Singapore', results: [] });
    expect((await read(id)).status).toBe('planning');
    expect(config).not.toHaveBeenCalled(); expect(relay).not.toHaveBeenCalled();
    await finish(id);
    const preview = await handle(`${path(id)}/attachment`);
    expect(preview.results).toHaveLength(10);
    expect(Object.keys(preview).sort()).toEqual(['country', 'results', 'subject_name', 'subject_type']);
    expect(preview.results.every(result => Object.keys(result).sort().join() === 'title,url')).toBe(true);
    await expect(handle(`${path(id)}/attachment`, { body: { hit_ids: [999] } })).rejects.toMatchObject({ status: 400 });
    await expect(handle(`${path(id)}/attachment`, { body: { hit_ids: Array(21).fill(1) } })).rejects.toMatchObject({ status: 400 });
  });

  it('imports only exact prepared session queries and validates the whole batch before mutation', async () => {
    cfg.provider = 'session'; const id = await create(); await poll(id);
    const { queries } = await handle(`${path(id)}/queries`);
    const before = await read(id);
    await expect(handle(`${path(id)}/import`, { method: 'POST', body: { results: [{ q: queries[0].q, items: [fixture()] }, { q: 'Other Person', items: [] }] } })).rejects.toMatchObject({ status: 400 });
    expect(await read(id)).toEqual(before);
    await expect(handle(`${path(id)}/import`, { method: 'POST', body: { results: [{ q: queries[0].q, items: [{ ...fixture(), url: 'javascript:alert(1)' }] }] } })).rejects.toMatchObject({ status: 400 });
    const body = { results: [{ q: queries[0].q, items: [fixture()] }] };
    expect(await handle(`${path(id)}/import`, { method: 'POST', body })).toEqual({ imported: 1 });
    expect(await handle(`${path(id)}/import`, { method: 'POST', body })).toEqual({ imported: 0 });
    expect(relay).not.toHaveBeenCalled();
  });

  it('keeps successful query progress when another relay request fails and retries pending work only', async () => {
    live(3); const id = await create({ live_search_consent: true }); await poll(id);
    let failed = false;
    relay.mockImplementation(async ({ q }) => {
      if (q.endsWith(' news') && !failed) { failed = true; throw Object.assign(new Error('secret-provider-body'), { status: 429 }); }
      return { results: [fixture()], related: [] };
    });
    const paused = await poll(id);
    expect(paused.status).toBe('paused_budget'); expect(paused.progress.completed).toBe(2);
    expect(paused.error).not.toContain('secret-provider-body');
    expect((await read(id)).lease_until).toBe(0);
    expect(await handle(`${path(id)}/retry`, { method: 'POST' })).toEqual({ ok: true });
    relay.mockClear(); expect((await poll(id)).status).toBe('done'); expect(relay).toHaveBeenCalledOnce();
  });

  it('acquires one lease for concurrent polling tabs', async () => {
    live(); const id = await create({ live_search_consent: true }); await poll(id);
    const started = deferred(), response = deferred();
    relay.mockClear(); relay.mockImplementation(() => { started.resolve(); return response.promise; });
    const first = poll(id); await started.promise;
    const second = await poll(id);
    expect(second.status).toBe('searching'); expect(relay).toHaveBeenCalledTimes(3);
    expect((await read(id)).lease_until).toBe(NOW + 90_000);
    response.resolve({ results: [], related: [] });
    expect((await first).status).toBe('done');
  });

  it('preserves concurrent result-status and draft changes when a network step commits', async () => {
    live(6); const id = await create({ live_search_consent: true }); await poll(id); await poll(id);
    const existing = (await read(id)).hits[0], started = deferred(), response = deferred();
    relay.mockImplementation(() => { started.resolve(); return response.promise; });
    const pending = poll(id); await started.promise;
    await status(id, existing.id, 'not_me');
    await draft(id, existing.id, { template: 'inaccurate' });
    response.resolve({ results: [fixture()], related: [] }); await pending;
    const current = await read(id);
    expect(current.hits.find(hit => hit.id === existing.id).status).toBe('not_me');
    expect(current.drafts).toHaveLength(1);
  });

  it('cannot recreate a deleted scan when a search response arrives later', async () => {
    live(); const id = await create({ live_search_consent: true }); await poll(id);
    const started = deferred(), response = deferred();
    relay.mockImplementation(() => { started.resolve(); return response.promise; });
    const pending = poll(id), rejection = expect(pending).rejects.toMatchObject({ status: 404 }); await started.promise;
    expect(await handle(path(id), { method: 'DELETE' })).toEqual({ deleted: true });
    response.resolve({ results: [fixture()], related: [] }); await rejection;
    expect(await read(id)).toBeUndefined(); expect(store.put).toHaveBeenCalledOnce();
    await expect(status(id, 1, 'sent')).rejects.toMatchObject({ status: 404 });
  });

  it('discards results from an expired lease after a second tab has taken over', async () => {
    live(1); const id = await create({ live_search_consent: true }); await poll(id);
    const started = deferred(), oldResponse = deferred(); let calls = 0;
    relay.mockImplementation(() => {
      if (++calls === 1) { started.resolve(); return oldResponse.promise; }
      return { results: [fixture('Anne Lee', 'https://fresh.example/new')], related: [] };
    });
    const stale = poll(id); await started.promise; clock += 90_001;
    expect((await poll(id)).status).toBe('done');
    oldResponse.resolve({ results: [fixture('Anne Lee', 'https://stale.example/old')], related: [] }); await stale;
    expect((await read(id)).hits.map(hit => hit.url)).toEqual(['https://fresh.example/new']);
  });
});
