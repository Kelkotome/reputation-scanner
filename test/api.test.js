import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
let sqlite, env;
function prepare(sql, args = []) {
  const run = () => { const r = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; };
  return {
    bind: (...values) => prepare(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => run(), runSync: run,
  };
}
const payload = { full_name: 'Anne Lee', attestation: true, is_minor: false, harm_types: ['scam_fraud'], context: { country: 'Singapore' } };
async function api(path, method = 'GET', data, headers = {}) {
  const response = await worker.fetch(new Request(`http://localhost${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }), env);
  return { status: response.status, data: await response.json(), headers: response.headers };
}
async function create(data = {}) {
  const result = await api('/api/scan', 'POST', { ...payload, ...data });
  expect(result.status).toBe(201); return result.data.id;
}
async function finish(id) {
  for (let i = 0; i < 30; i++) {
    const response = await api(`/api/scan/${id}`);
    expect(response.status).toBe(200);
    expect(response.data.status).not.toBe('error');
    if (['done', 'awaiting_import', 'paused_budget'].includes(response.data.status)) return response.data;
  }
  throw new Error('Scan failed to finish within 30 steps');
}
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = { DB: { prepare, batch: async statements => {
    sqlite.exec('BEGIN');
    try { const output = statements.map(statement => statement.runSync()); sqlite.exec('COMMIT'); return output; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } }, SERP_PROVIDER: 'mock', IP_SALT: 'test-only-salt', ASSETS: { fetch: () => new Response('asset') } };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected external network in offline test'); }));
});
afterEach(() => { vi.unstubAllGlobals(); sqlite.close(); });

describe('scan API and pipeline using real SQLite', () => {
  it('requires valid self-search attestation, name, age and origin', async () => {
    for (const invalid of [{ attestation: false }, { full_name: 'A' }, { is_minor: 'false' }, { harm_types: ['unknown'] }]) expect((await api('/api/scan', 'POST', { ...payload, ...invalid })).status).toBe(400);
    expect((await api('/api/scan', 'POST', payload, { Origin: 'https://untrusted.example' })).status).toBe(403);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM scans').get().n).toBe(0);
  });
  it('routes sensitive searches directly to help without persisting a scan', async () => {
    const result = await api('/api/scan', 'POST', { ...payload, harm_types: ['sensitive_intimate'] });
    expect(result.data).toMatchObject({ id: null, help_only: true, show_help_first: true });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM scans').get().n).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('deduplicates a recent self-search and preserves rate limits after deletion', async () => {
    env.SCANS_PER_IP_PER_DAY = 1;
    const id = await create();
    expect((await api('/api/scan', 'POST', payload)).data).toMatchObject({ id, reused: true });
    expect((await api('/api/scan', 'POST', { ...payload, full_name: 'Benny Lee' })).status).toBe(429);
    expect((await api(`/api/scan/${id}`, 'DELETE')).status).toBe(200);
    expect((await api('/api/scan', 'POST', payload)).status).toBe(429);
  });
  it.each(['mock', 'session'])('starts a new live-provider scan instead of reusing a recent %s scan', async previousProvider => {
    env.SERP_PROVIDER = previousProvider;
    const previousId = await create();
    env.SERP_PROVIDER = 'serper';
    const liveId = await create();
    expect(liveId).not.toBe(previousId);
    expect(sqlite.prepare('SELECT provider FROM scans WHERE id = ?').get(liveId).provider).toBe('serper');
    expect((await api('/api/scan', 'POST', payload)).data).toMatchObject({ id: liveId, reused: true });
    env.SERP_PROVIDER = previousProvider;
    expect((await api('/api/scan', 'POST', payload)).data).toMatchObject({ id: previousId, reused: true });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM scans').get().n).toBe(2);
    expect(sqlite.prepare('SELECT scans FROM ip_daily').get().scans).toBe(2);
    // Creation alone must not contact a search or AI service.
    expect(fetch).not.toHaveBeenCalled();
  });
  it('finishes mock scans, limits shown results, and never fetches fixture pages', async () => {
    const id = await create(), report = await finish(id);
    expect(report.status).toBe('done');
    expect(report.shown).toHaveLength(10);
    expect(report.moreCount).toBeGreaterThan(0);
    expect(report.progress.completed).toBe(report.progress.total);
    expect(report.provider).toBe('mock');
    expect(report.usage.cost_usd).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect((await api(`/api/scan/${id}`)).headers.get('cache-control')).toBe('no-store');
  });
  it('creates drafts for platform and unmapped results, tracks status, and rejects cross-scan access', async () => {
    const id = await create(); await finish(id);
    const reddit = sqlite.prepare("SELECT * FROM hits WHERE scan_id = ? AND domain = 'reddit.com'").get(id);
    const header = { 'X-Scan-Id': id };
    let result = await api(`/api/hit/${reddit.id}/draft`, 'POST', { template: 'inaccurate', owns_content: false }, header);
    expect(result.status).toBe(200); expect(result.data.channel.name).toBe('Reddit'); expect(result.data.draft.body).toContain(reddit.url);
    const other = sqlite.prepare("SELECT * FROM hits WHERE scan_id = ? AND category = 'doxxing_personal_info'").get(id);
    result = await api(`/api/hit/${other.id}/draft`, 'POST', { template: 'personal_info' }, header);
    expect(result.status).toBe(200); expect(result.data.abuse.host).toContain('fixture');
    expect((await api(`/api/hit/${reddit.id}`, 'PATCH', { status: 'sent' }, header)).status).toBe(200);
    expect(sqlite.prepare('SELECT status FROM hits WHERE id = ?').get(reddit.id).status).toBe('sent');
    const otherId = await create({ full_name: 'Benny Lee' });
    expect((await api(`/api/hit/${reddit.id}`, 'PATCH', { status: 'removed' }, { 'X-Scan-Id': otherId })).status).toBe(404);
    expect((await api(`/api/hit/${reddit.id}/draft`, 'POST', { template: 'inaccurate' })).status).toBe(404);
  });
  it('does not offer or accept copyright templates for a minor', async () => {
    const id = await create({ is_minor: true }); await finish(id);
    const hit = sqlite.prepare('SELECT * FROM hits WHERE scan_id = ? AND classified = 1 LIMIT 1').get(id);
    const result = await api(`/api/hit/${hit.id}/draft`, 'POST', { owns_content: true }, { 'X-Scan-Id': id });
    expect(result.status).toBe(200); expect(result.data.templates.some(x => x.id === 'copyright')).toBe(false);
    expect((await api(`/api/hit/${hit.id}/draft`, 'POST', { owns_content: true, template: 'copyright' }, { 'X-Scan-Id': id })).status).toBe(400);
  });
  it('preserves a newly declared minor status when reusing an existing scan', async () => {
    const id = await create();
    const reused = await api('/api/scan', 'POST', { ...payload, is_minor: true });
    expect(reused.data).toMatchObject({ id, reused: true, show_help_first: true });
    expect(sqlite.prepare('SELECT is_minor FROM scans WHERE id = ?').get(id).is_minor).toBe(1);
    await api('/api/scan', 'POST', payload);
    expect(sqlite.prepare('SELECT is_minor FROM scans WHERE id = ?').get(id).is_minor).toBe(1);
  });
  it('imports a session scan idempotently and classifies without an API key', async () => {
    env.SERP_PROVIDER = 'session'; env.MAX_QUERIES = 2;
    const id = await create(); expect((await finish(id)).status).toBe('awaiting_import');
    const { data: { queries } } = await api(`/api/scan/${id}/queries`);
    const results = queries.map(q => ({ q: q.q, items: [{ title: 'Anne Lee complaint', snippet: 'A complaint about terrible service in Singapore.', url: 'https://forum.example/anne-lee' }] }));
    expect((await api(`/api/scan/${id}/import`, 'POST', { results })).data.imported).toBe(1);
    expect((await api(`/api/scan/${id}/import`, 'POST', { results })).data.imported).toBe(0);
    const report = await finish(id); expect(report.status).toBe('done'); expect(report.shown).toHaveLength(1);
    expect((await api(`/api/scan/${id}/import`, 'POST', { results: [{ q: 'not a scan query', items: [] }] })).status).toBe(400);
  });
  it.each([undefined, 'false'])('plans, classifies and drafts locally with both keys configured and cloud AI disabled (%j)', async flag => {
    env.SERP_PROVIDER = 'session'; env.MAX_QUERIES = 1;
    env.ANTHROPIC_API_KEY = 'test-anthropic-key'; env.OPENAI_API_KEY = 'test-openai-key';
    // A spent cloud budget must not block the local fallback path.
    env.DAILY_USD_LIMIT = 0;
    if (flag !== undefined) env.CLOUD_AI_ENABLED = flag;
    expect((await api('/api/config')).data).toMatchObject({ demo: false, cloud_ai_enabled: false });
    const pageUrl = 'https://www.reddit.com/r/example/comments/local/anne-lee';
    vi.mocked(fetch).mockImplementation(async url => {
      expect(url).toBe(pageUrl);
      return new Response('<p>Anne Lee complaint about terrible service in Singapore.</p>', { headers: { 'Content-Type': 'text/html' } });
    });
    const id = await create({ email: 'anne@example.com' });
    expect((await finish(id)).status).toBe('awaiting_import');
    expect(fetch).not.toHaveBeenCalled();
    const { data: { queries } } = await api(`/api/scan/${id}/queries`);
    expect(queries).toHaveLength(1);
    const imported = await api(`/api/scan/${id}/import`, 'POST', { results: [{ q: queries[0].q, items: [{
      title: 'Anne Lee complaint', snippet: 'Terrible service in Singapore.', url: pageUrl,
    }] }] });
    expect(imported.data.imported).toBe(1);
    const report = await finish(id);
    expect(report.status).toBe('done');
    expect(report.shown).toHaveLength(1);
    expect(report.shown[0].category).toBe('negative_news_forum');
    expect(report.shown[0].reason).toContain('heuristic');
    const hit = sqlite.prepare('SELECT id FROM hits WHERE scan_id = ?').get(id);
    const result = await api(`/api/hit/${hit.id}/draft`, 'POST', { template: 'outdated' }, { 'X-Scan-Id': id });
    expect(result.status).toBe(200);
    expect(result.data.draft.source).toBe('template');
    expect(result.data.draft.body).toContain(pageUrl);
    expect(result.data.draft.body).toContain('anne@example.com');
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM drafts WHERE scan_id = ?').get(id).n).toBe(1);
    expect(report.usage).toMatchObject({ in_tokens: 0, out_tokens: 0, cost_usd: 0 });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([pageUrl]);
  });
  it('shows only generic help for sensitive imports and never fetches their pages', async () => {
    env.SERP_PROVIDER = 'session'; env.MAX_QUERIES = 1;
    const id = await create(); await finish(id);
    const { data: { queries } } = await api(`/api/scan/${id}/queries`);
    await api(`/api/scan/${id}/import`, 'POST', { results: [{ q: queries[0].q, items: [{ title: 'Anne Lee intimate images', snippet: 'A sensitive result', url: 'https://forum.example/anne-lee' }] }] });
    const report = await finish(id);
    expect(report.helpRequired).toBe(true); expect(report.shown).toEqual([]); expect(report.sameName).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('respects polling leases and refuses deletion while a step is active', async () => {
    const id = await create(); sqlite.prepare('UPDATE scans SET lease_until = ? WHERE id = ?').run(Date.now() + 30_000, id);
    expect((await api(`/api/scan/${id}`)).data.status).toBe('planning');
    expect((await api(`/api/scan/${id}`, 'DELETE')).status).toBe(409);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM queries').get().n).toBe(0);
  });
  it('deletes scan-linked records and cached search snippets', async () => {
    const id = await create(); await finish(id);
    const hit = sqlite.prepare("SELECT * FROM hits WHERE scan_id = ? AND domain = 'reddit.com'").get(id);
    await api(`/api/hit/${hit.id}/draft`, 'POST', { template: 'inaccurate' }, { 'X-Scan-Id': id });
    expect((await api('/api/help', 'POST', { scan_id: id, name: 'Anne', email: 'anne@example.com', message: 'Please review', hit_ids: [hit.id] })).status).toBe(201);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM serp_cache').get().n).toBeGreaterThan(0);
    expect((await api(`/api/scan/${id}`, 'DELETE')).data.deleted).toBe(true);
    for (const table of ['scans', 'hits', 'queries', 'drafts', 'requests', 'scan_cache', 'serp_cache']) expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(0);
    expect((await api(`/api/scan/${id}`)).status).toBe(404);
  });
  it('pauses at the budget boundary and retries an error from its checkpoint', async () => {
    env.SERP_PROVIDER = 'serper'; env.SERP_API_KEY = 'fake'; env.DAILY_SERP_LIMIT = 0;
    const id = await create(); expect((await finish(id)).status).toBe('paused_budget'); expect(fetch).not.toHaveBeenCalled();
    env.DAILY_SERP_LIMIT = 2;
    sqlite.prepare("UPDATE scans SET status = 'error', error = 'Failed' WHERE id = ?").run(id);
    expect((await api(`/api/scan/${id}/retry`, 'POST', {})).status).toBe(200);
    expect(sqlite.prepare('SELECT status, error FROM scans WHERE id = ?').get(id)).toMatchObject({ status: 'planning', error: null });
  });
  it('counts paid autocomplete against the same atomic SERP allowance', async () => {
    env.SERP_PROVIDER = 'serper'; env.SERP_API_KEY = 'fake'; env.DAILY_SERP_LIMIT = 1;
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ suggestions: [] }), { headers: { 'Content-Type': 'application/json' } }));
    const id = await create();
    const planned = await api(`/api/scan/${id}`);
    expect(planned.data.status).toBe('searching');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(planned.data.usage.serp_queries).toBe(1);
    const paused = await finish(id);
    expect(paused.status).toBe('paused_budget');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('reports rejected search credentials without persisting the key or provider response body', async () => {
    env.SERP_PROVIDER = 'serper'; env.SERP_API_KEY = 'dummy-secret-key'; env.MAX_QUERIES = 1;
    vi.mocked(fetch).mockImplementation(async () => new Response('Unauthorized provider-body-marker dummy-secret-key', { status: 403 }));
    const id = await create();
    expect((await api(`/api/scan/${id}`)).data.status).toBe('searching');
    const report = await api(`/api/scan/${id}`);
    const safeMessage = 'The search provider rejected the configured API credentials. Check that the key belongs to the selected search provider, then retry.';
    expect(report.status).toBe(200);
    expect(report.data).toMatchObject({ status: 'error', error: safeMessage });
    expect(sqlite.prepare('SELECT error FROM scans WHERE id = ?').get(id).error).toBe(safeMessage);
    expect(JSON.stringify(report.data)).not.toMatch(/dummy-secret-key|provider-body-marker/);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM serp_cache').get().n).toBe(0);
  });
  it('rejects non-HTTP imports and does not persist page content for them', async () => {
    env.SERP_PROVIDER = 'session'; env.MAX_QUERIES = 1;
    const id = await create(); await finish(id);
    const { data: { queries } } = await api(`/api/scan/${id}/queries`);
    const response = await api(`/api/scan/${id}/import`, 'POST', { results: [{ q: queries[0].q, items: [{ title: 'Anne Lee scam', url: 'javascript:alert(1)' }] }] });
    expect(response.data.imported).toBe(0); expect(sqlite.prepare('SELECT COUNT(*) AS n FROM hits').get().n).toBe(0);
  });
});

describe('business scans using the existing scan storage', () => {
  const business = {
    ...payload, subject_type: 'business', full_name: 'Acme Studio', email: 'alex@acme.example',
    context: { country: 'Singapore', representative_name: 'Alex Example', website: 'https://acme.example', industry: 'Design' },
  };

  it('stores business context canonically and exposes the subject type in reports', async () => {
    const id = await create({ ...business, context: { ...business.context, subject_type: 'person', website: 'https://ACME.example/about?tracking=discard#team' } });
    const saved = sqlite.prepare('SELECT context_json, is_minor FROM scans WHERE id = ?').get(id);
    expect(JSON.parse(saved.context_json)).toMatchObject({
      subject_type: 'business', representative_name: 'Alex Example', website: 'https://acme.example', industry: 'Design',
    });
    expect(saved.is_minor).toBe(0);
    const report = await finish(id);
    expect(report).toMatchObject({ subject_type: 'business', full_name: 'Acme Studio', is_minor: false, status: 'done' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps omitted subject type and legacy rows person-based despite nested spoofing', async () => {
    const id = await create({ context: { ...payload.context, subject_type: 'business' }, is_minor: true });
    const saved = sqlite.prepare('SELECT context_json FROM scans WHERE id = ?').get(id);
    expect(JSON.parse(saved.context_json).subject_type).toBe('person');
    // Existing installations have context rows without any subject_type field.
    sqlite.prepare('UPDATE scans SET context_json = ?, name_norm = ? WHERE id = ?').run(JSON.stringify(payload.context), 'anne lee', id);
    expect(await finish(id)).toMatchObject({ subject_type: 'person', is_minor: true });
    const current = await api('/api/scan', 'POST', { ...payload, subject_type: 'person', is_minor: true });
    expect(current.status).toBe(201);
    expect(current.data.id).not.toBe(id);
    expect(current.data.show_help_first).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown subject type', { subject_type: 'organisation' }],
    ['missing authority confirmation', { attestation: false }],
    ['minor business', { is_minor: true }],
    ['missing representative', { context: { country: 'Singapore' } }],
    ['short representative', { context: { representative_name: 'A' } }],
    ['long representative', { context: { representative_name: 'A'.repeat(81) } }],
    ['non-string representative', { context: { representative_name: 123 } }],
    ['long industry', { context: { ...business.context, industry: 'x'.repeat(121) } }],
  ])('rejects %s without creating a scan', async (label, invalid) => {
    const result = await api('/api/scan', 'POST', { ...business, ...invalid });
    expect(result.status).toBe(400);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM scans').get().n).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'javascript:alert(1)', 'file:///etc/passwd', 'not a website',
    'https://user:password@acme.example', 'http://localhost:8787',
    'http://192.168.1.4', 'http://127.0.0.1', 'http://[::1]',
    'http://private.internal', 'https://intranet',
  ])('rejects unsafe business website %s without requesting it', async website => {
    expect((await api('/api/scan', 'POST', { ...business, context: { ...business.context, website } })).status).toBe(400);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM scans').get().n).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts a business without an optional website', async () => {
    const { website, ...context } = business.context;
    const id = await create({ ...business, context });
    expect(await finish(id)).toMatchObject({ subject_type: 'business', status: 'done' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['sensitive_intimate', 'child_safety'])('routes business selection %s to help without creating a business or intimate-content case', async harm => {
    const result = await api('/api/scan', 'POST', { ...business, harm_types: [harm] });
    expect(result.data).toMatchObject({ id: null, help_only: true, show_help_first: true });
    for (const table of ['scans', 'takedown_cases']) expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('isolates a business from a same-name person and preserves the person’s minor declaration', async () => {
    const personId = await create({ full_name: business.full_name, is_minor: true });
    const businessId = await create(business);
    expect(businessId).not.toBe(personId);
    expect((await api('/api/scan', 'POST', business)).data).toMatchObject({ id: businessId, reused: true, show_help_first: false });
    expect((await api('/api/scan', 'POST', { ...payload, full_name: business.full_name })).data)
      .toMatchObject({ id: personId, reused: true, show_help_first: true });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM scans').get().n).toBe(2);
    expect(sqlite.prepare('SELECT scans FROM ip_daily').get().scans).toBe(2);
  });

  it('reuses equivalent business website identities but separates other sites and representatives', async () => {
    const originalId = await create(business);
    const equivalent = await api('/api/scan', 'POST', { ...business, context: { ...business.context, website: 'https://www.ACME.example./about?ref=changed#team' } });
    expect(equivalent.data).toMatchObject({ id: originalId, reused: true });
    const otherSite = await create({ ...business, context: { ...business.context, website: 'https://other-acme.example' } });
    const otherRepresentative = await create({ ...business, context: { ...business.context, representative_name: 'Blair Example' } });
    const otherContact = await create({ ...business, email: 'alex.other@acme.example' });
    expect(new Set([originalId, otherSite, otherRepresentative, otherContact]).size).toBe(4);
    expect(sqlite.prepare('SELECT scans FROM ip_daily').get().scans).toBe(4);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps person and business mock fixtures separate when cached queries share a name', async () => {
    const personId = await create({ full_name: business.full_name }); await finish(personId);
    const businessId = await create(business); await finish(businessId);
    const profile = id => sqlite.prepare("SELECT url FROM hits WHERE scan_id = ? AND url LIKE 'https://sg.linkedin.com/%'").get(id);
    const contact = id => sqlite.prepare("SELECT title, snippet, category FROM hits WHERE scan_id = ? AND url LIKE 'https://people-directory.example.com/%'").get(id);
    expect(profile(personId).url).toContain('/in/acme-studio');
    expect(profile(businessId).url).toContain('/company/acme-studio');
    expect(contact(personId).snippet).toContain('lives at');
    expect(contact(businessId).snippet).toContain('public business listing');
    expect(contact(businessId).category).toBe('neutral');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('creates local business drafts signed by the representative and requires explicit copyright ownership', async () => {
    env.ANTHROPIC_API_KEY = 'unused-key'; env.OPENAI_API_KEY = 'unused-key'; env.CLOUD_AI_ENABLED = 'false';
    const id = await create(business); await finish(id);
    const hit = sqlite.prepare("SELECT * FROM hits WHERE scan_id = ? AND domain = 'reddit.com'").get(id);
    const header = { 'X-Scan-Id': id };
    const discovery = await api(`/api/hit/${hit.id}/draft`, 'POST', { owns_content: false }, header);
    expect(discovery.status).toBe(200);
    expect(discovery.data.templates.some(template => template.id === 'copyright')).toBe(false);
    expect((await api(`/api/hit/${hit.id}/draft`, 'POST', { template: 'copyright', owns_content: false }, header)).status).toBe(400);
    for (const template of ['inaccurate', 'copyright']) {
      const result = await api(`/api/hit/${hit.id}/draft`, 'POST', { template, owns_content: template === 'copyright' }, header);
      expect(result.status).toBe(200);
      expect(result.data.draft.source).toBe('template');
      for (const value of [business.full_name, business.context.representative_name, business.email, hit.url]) expect(result.data.draft.body).toContain(value);
      expect(result.data.draft.body).not.toContain('I am the owner of the work');
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM drafts WHERE scan_id = ?').get(id).n).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps personal-information templates ineligible for business hits and uses company wording for a name mix-up', async () => {
    const id = await create(business); await finish(id);
    const hit = sqlite.prepare("SELECT * FROM hits WHERE scan_id = ? AND domain = 'reddit.com'").get(id);
    const header = { 'X-Scan-Id': id };
    sqlite.prepare("UPDATE hits SET category = 'doxxing_personal_info' WHERE id = ?").run(hit.id);
    const discovery = await api(`/api/hit/${hit.id}/draft`, 'POST', {}, header);
    expect(discovery.status).toBe(200);
    expect(discovery.data.templates.some(template => template.id === 'personal_info')).toBe(false);
    expect((await api(`/api/hit/${hit.id}/draft`, 'POST', { template: 'personal_info' }, header)).status).toBe(400);
    sqlite.prepare("UPDATE hits SET category = 'same_name_other_person', match_confidence = 0.2, status = 'not_me' WHERE id = ?").run(hit.id);
    const mixup = await api(`/api/hit/${hit.id}/draft`, 'POST', { template: 'same_name' }, header);
    expect(mixup.status).toBe(200);
    expect(mixup.data.draft.body).toContain(business.full_name);
    expect(mixup.data.draft.body).toContain(business.context.representative_name);
    expect(mixup.data.draft.body).not.toContain(`My name is ${business.full_name}`);
    expect(mixup.data.draft.body).not.toContain('two different people');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('country selection and country-aware scan reuse', () => {
  const storedContext = id => JSON.parse(sqlite.prepare('SELECT context_json FROM scans WHERE id = ?').get(id).context_json);

  it('normalizes selected codes and derives the label instead of trusting conflicting client text', async () => {
    const id = await create({ context: { country_code: ' US ', country: 'Singapore' } });
    expect(storedContext(id)).toMatchObject({ country_code: 'us', country: 'United States' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('treats GB and UK as the same canonical country and reuses the same scan', async () => {
    const id = await create({ context: { country_code: 'GB' } });
    expect(storedContext(id)).toMatchObject({ country_code: 'uk', country: 'United Kingdom' });
    const repeated = await api('/api/scan', 'POST', { ...payload, context: { country_code: 'uk' } });
    expect(repeated.data).toMatchObject({ id, reused: true });
    expect(sqlite.prepare('SELECT scans FROM ip_daily').get().scans).toBe(1);
  });

  it.each([{}, { country: '' }, { country_code: '', country: 'Singapore' }])('keeps no country preference empty for %j', async context => {
    const id = await create({ context });
    expect(storedContext(id)).toMatchObject({ country_code: '', country: '' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [' Singapore ', 'sg', 'Singapore'],
    ['united states', 'us', 'United States'],
    ['Czech Republic', 'cz', 'Czechia'],
    ['Swaziland', 'sz', 'Eswatini'],
  ])('accepts the known legacy country label %s', async (label, code, name) => {
    const id = await create({ context: { country: label } });
    expect(storedContext(id)).toMatchObject({ country_code: code, country: name });
  });

  it.each([
    { country_code: 'zz' }, { country_code: 'an' }, { country_code: 'usa' },
    { country_code: null }, { country_code: 1 }, { country_code: ['sg'] },
    { country: 'Somewhere not on the country list' },
  ])('rejects an invalid country choice without creating a scan (%j)', async context => {
    const result = await api('/api/scan', 'POST', { ...payload, context });
    expect(result.status).toBe(400);
    expect(result.data.error).toMatch(/choose a country or region/i);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM scans').get().n).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['person', 'business'])('separates %s scans by country while reusing matching selections', async subjectType => {
    const subject = { ...payload, subject_type: subjectType, context: { representative_name: 'Alex Example' } };
    const ids = [];
    for (const countryCode of ['us', 'sg', '']) {
      const request = { ...subject, context: { ...subject.context, country_code: countryCode } };
      const id = await create(request);
      ids.push(id);
      expect((await api('/api/scan', 'POST', request)).data).toMatchObject({ id, reused: true });
    }
    expect(new Set(ids).size).toBe(3);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM scans').get().n).toBe(3);
    expect(sqlite.prepare('SELECT scans FROM ip_daily').get().scans).toBe(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves a minor declaration when the selected country is unchanged', async () => {
    const request = { ...payload, context: { country_code: 'us' } };
    const id = await create(request);
    const safer = await api('/api/scan', 'POST', { ...request, is_minor: true });
    expect(safer.data).toMatchObject({ id, reused: true, show_help_first: true });
    expect((await api('/api/scan', 'POST', request)).data).toMatchObject({ id, reused: true, show_help_first: true });
    expect(sqlite.prepare('SELECT is_minor FROM scans WHERE id = ?').get(id).is_minor).toBe(1);
  });

  it.each(['person', 'business'])('keeps legacy %s reports readable but does not reuse country-unaware results', async subjectType => {
    const request = { ...payload, subject_type: subjectType, email: 'alex@example.com', context: { country: 'United States', representative_name: 'Alex Example' } };
    const oldId = await create(request);
    const oldContext = storedContext(oldId);
    delete oldContext.country_code;
    const oldIdentity = subjectType === 'business'
      ? 'business:' + JSON.stringify(['anne lee', '', 'alex example', 'alex@example.com'])
      : 'anne lee';
    sqlite.prepare('UPDATE scans SET context_json = ?, name_norm = ? WHERE id = ?').run(JSON.stringify(oldContext), oldIdentity, oldId);
    expect(await finish(oldId)).toMatchObject({ id: oldId, subject_type: subjectType, status: 'done' });
    const newId = await create(request);
    expect(newId).not.toBe(oldId);
    expect(storedContext(newId)).toMatchObject({ country_code: 'us', country: 'United States' });
    expect((await api('/api/scan', 'POST', request)).data).toMatchObject({ id: newId, reused: true });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM scans').get().n).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
