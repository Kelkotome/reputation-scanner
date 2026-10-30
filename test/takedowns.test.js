import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import worker from '../src/index.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const FORTNIGHT = 14 * 864e5;
const NOW = Date.UTC(2026, 8, 24, 12);
let sqlite, env, delayReads;

function prepare(sql, args = []) {
  const runSync = () => {
    const result = sqlite.prepare(sql).run(...args);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  };
  return {
    bind: (...values) => prepare(sql, values),
    first: async () => {
      const row = sqlite.prepare(sql).get(...args) || null;
      if (delayReads) await new Promise(resolve => setTimeout(resolve, 10));
      return row;
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => runSync(), runSync,
  };
}

const base = {
  affected_name: 'Anne Lee', reporter_name: 'Anne Lee', reporter_email: 'anne@example.com',
  role: 'self', age_at_creation: 'adult', authorised: true, shared_without_consent: true,
  urls: ['https://example.com/report-fixture/post?token=keep-me&ref=source'],
};

async function api(path, method = 'GET', data) {
  const response = await worker.fetch(new Request(`https://scanner.example${path}`, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), env);
  expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  return { status: response.status, data: await response.json(), headers: response.headers };
}
async function create(extra = {}) {
  const result = await api('/api/takedowns', 'POST', { ...base, ...extra });
  expect(result.status).toBe(201);
  expect(result.data.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  return result.data.id;
}
const report = async id => (await api(`/api/takedowns/${id}`)).data;
const change = (id, itemId, patch) => api(`/api/takedowns/${id}/items/${itemId}`, 'PATCH', patch);
function rowCounts() {
  return Object.fromEntries(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .map(({ name }) => [name, sqlite.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]));
}

beforeEach(() => {
  delayReads = false;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = { DB: { prepare, batch: async statements => {
    sqlite.exec('BEGIN');
    try { const result = statements.map(statement => statement.runSync()); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  } }, IP_SALT: 'takedown-test-only', SERP_PROVIDER: 'mock', ASSETS: { fetch: () => new Response('static fixture') } };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Takedown URL-only workflow must never make an external request'); }));
});
afterEach(() => {
  try { expect(fetch).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); sqlite.close(); }
});

describe('URL-only takedown organizer', () => {
  it('creates an adult case with textual requests while preserving exact source query tokens', async () => {
    const urls = [
      'https://example.com/report-fixture/photo.jpg?token=a%2Fb&ref=original&utm_source=keep#media-2',
      'https://www.reddit.com/r/fixture/comments/not-a-real-post/?context=3',
    ];
    const id = await create({ urls });
    const result = await api(`/api/takedowns/${id}`);
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(result.data.items).toHaveLength(2);
    expect(result.data.items.map(item => item.url)).toEqual(urls);
    expect(result.data.due_count).toBe(0);
    for (const item of result.data.items) {
      expect(item.host).toBeTypeOf('string');
      expect(item.channel).toMatchObject({ name: expect.any(String), instructions: expect.any(String) });
      // Unmapped websites have instructions without an invented reporting URL.
      if (item.channel.url !== null) expect(new URL(item.channel.url).protocol).toBe('https:');
      expect(item.draft).toMatchObject({ subject: expect.any(String), body: expect.any(String), followup_subject: expect.any(String), followup_body: expect.any(String) });
      expect(item.draft.body).toContain(item.url);
      expect(item.draft.body).toContain('Anne Lee');
      expect(item.draft.body).toContain('anne@example.com');
      expect(item.draft.body).not.toMatch(/<(?:img|iframe|video|script)\b/i);
      expect(item.sent_at).toBeNull();
      expect(item.due_at).toBeNull();
      expect(item.due).toBe(false);
    }
  });
  it.each(['under18', 'unknown'])('routes age-at-creation %s to help without persisting any case', async age => {
    const before = rowCounts();
    const result = await api('/api/takedowns', 'POST', { ...base, age_at_creation: age });
    expect(result.status).toBeGreaterThanOrEqual(200);
    expect(result.status).toBeLessThan(300);
    expect(result.data).toMatchObject({ help_only: true, links: expect.any(Array), reason: expect.any(String) });
    expect(result.data.links.length).toBeGreaterThan(0);
    expect(rowCounts()).toEqual(before);
  });
  it('provides specialist help before requesting personal details for uncertain age', async () => {
    const before = rowCounts();
    const result = await api('/api/takedowns', 'POST', { age_at_creation: 'unknown' });
    expect(result.status).toBe(200);
    expect(result.data.help_only).toBe(true);
    expect(rowCounts()).toEqual(before);
  });
  it.each([
    { authorised: false }, { authorised: undefined }, { authorised: 'true' },
    { shared_without_consent: false }, { shared_without_consent: undefined },
    { role: 'unrelated' }, { age_at_creation: 'invalid' },
    { affected_name: '' }, { reporter_name: '' }, { reporter_email: 'invalid-email' },
  ])('rejects missing consent, authority or invalid reporter input: %j', async invalid => {
    const before = rowCounts();
    expect((await api('/api/takedowns', 'POST', { ...base, ...invalid })).status).toBe(400);
    expect(rowCounts()).toEqual(before);
  });
  it('supports an authorised representative without describing them as the affected person', async () => {
    const id = await create({ reporter_name: 'Casey Tan', reporter_email: 'casey@example.com', role: 'representative' });
    const { items } = await report(id);
    expect(items[0].draft.body).toContain('Casey Tan');
    expect(items[0].draft.body).toContain('Anne Lee');
    expect(items[0].draft.body).toMatch(/on behalf|representative|represent/i);
  });
  it.each([
    'javascript:alert(1)', 'file:///tmp/photo.jpg', 'data:image/png;base64,AAAA',
    'https://person:password@example.com/private', 'http://127.0.0.1/photo.jpg',
    'http://localhost/media', 'http://10.0.0.1/post', 'http://192.168.1.10/post',
    'http://[::1]/post', 'http://[fe80::1]/post', 'http://[::ffff:192.168.1.2]/post',
  ])('rejects unsafe URL %s without touching case storage', async url => {
    const before = rowCounts();
    expect((await api('/api/takedowns', 'POST', { ...base, urls: [url] })).status).toBe(400);
    expect(rowCounts()).toEqual(before);
  });
  it('requires one to twenty-five URLs and refuses a partially invalid list atomically', async () => {
    for (const urls of [[], Array.from({ length: 26 }, (_, i) => `https://example.com/fixture/${i}`), [base.urls[0], 'javascript:alert(1)']]) {
      const before = rowCounts();
      expect((await api('/api/takedowns', 'POST', { ...base, urls })).status).toBe(400);
      expect(rowCounts()).toEqual(before);
    }
  });
  it('starts a fourteen-day reminder only after confirmed manual sending', async () => {
    const id = await create(), item = (await report(id)).items[0];
    expect((await change(id, item.id, { status: 'sent' })).status).toBe(400);
    expect((await report(id)).items[0].sent_at).toBeNull();
    expect((await change(id, item.id, { status: 'sent', accuracy_confirmed: true, reference: 'Fixture report 123' })).status).toBe(200);
    const sent = (await report(id)).items[0];
    expect(sent.sent_at).toBe(NOW);
    expect(sent.due_at).toBe(NOW + FORTNIGHT);
    expect(sent.reference).toBe('Fixture report 123');
    expect(sent.due).toBe(false);
  });
  it('accepts historical sending dates and marks the request due exactly fourteen days later', async () => {
    const id = await create(), item = (await report(id)).items[0];
    expect((await change(id, item.id, { status: 'sent', accuracy_confirmed: true, sent_at: NOW - FORTNIGHT })).status).toBe(200);
    const current = await report(id);
    expect(current.items[0]).toMatchObject({ sent_at: NOW - FORTNIGHT, due_at: NOW, due: true });
    expect(current.due_count).toBe(1);
  });
  it('does not postpone an existing reminder when sent is submitted twice', async () => {
    const id = await create(), item = (await report(id)).items[0], originallySent = NOW - FORTNIGHT;
    await change(id, item.id, { status: 'sent', accuracy_confirmed: true, sent_at: originallySent });
    expect((await change(id, item.id, { status: 'sent', accuracy_confirmed: true, sent_at: NOW })).status).toBe(200);
    expect((await report(id)).items[0]).toMatchObject({ sent_at: originallySent, due_at: NOW, due: true });
  });
  it('retains one consistent original date when duplicate sends race through stale reads', async () => {
    const id = await create(), item = (await report(id)).items[0];
    delayReads = true;
    const dates = [NOW - FORTNIGHT, NOW];
    const results = await Promise.all(dates.map(sent_at => change(id, item.id, { status: 'sent', accuracy_confirmed: true, sent_at })));
    expect(results.every(result => result.status === 200)).toBe(true);
    const current = (await report(id)).items[0];
    expect(dates).toContain(current.sent_at);
    expect(current.due_at).toBe(current.sent_at + FORTNIGHT);
    expect(current.due).toBe(current.sent_at === dates[0]);
  });
  it('does not reopen a report when marking removed races with a repeated sent action', async () => {
    const id = await create(), item = (await report(id)).items[0];
    await change(id, item.id, { status: 'sent', accuracy_confirmed: true, sent_at: NOW - FORTNIGHT });
    delayReads = true;
    const [closed, sent] = await Promise.all([
      change(id, item.id, { status: 'removed' }),
      change(id, item.id, { status: 'sent', accuracy_confirmed: true }),
    ]);
    expect(closed.status).toBe(200);
    expect([200, 409]).toContain(sent.status);
    expect((await report(id)).items[0]).toMatchObject({ status: 'removed', due: false });
  });
  it('preserves a newly recorded platform reference when a duplicate send omits that field', async () => {
    const id = await create(), item = (await report(id)).items[0];
    delayReads = true;
    const results = await Promise.all([
      change(id, item.id, { status: 'sent', accuracy_confirmed: true, reference: 'Platform receipt ABC' }),
      change(id, item.id, { status: 'sent', accuracy_confirmed: true }),
    ]);
    expect(results.every(result => result.status === 200)).toBe(true);
    expect((await report(id)).items[0].reference).toBe('Platform receipt ABC');
  });
  it('does not flag the reminder before the exact fourteen-day threshold', async () => {
    const id = await create(), item = (await report(id)).items[0];
    await change(id, item.id, { status: 'sent', accuracy_confirmed: true, sent_at: NOW - FORTNIGHT + 1 });
    expect((await report(id)).items[0].due).toBe(false);
    Date.now.mockReturnValue(NOW + 1);
    const current = await report(id);
    expect(current.items[0].due).toBe(true);
    expect(current.due_count).toBe(1);
  });
  it('rejects a future or nonnumeric sent timestamp', async () => {
    const id = await create(), item = (await report(id)).items[0];
    for (const sent_at of [NOW + 1, 'yesterday', -1]) {
      expect((await change(id, item.id, { status: 'sent', accuracy_confirmed: true, sent_at })).status).toBe(400);
      expect((await report(id)).items[0].sent_at).toBeNull();
    }
  });
  it('requires sent status and fresh accuracy confirmation before marking a follow-up', async () => {
    const id = await create(), item = (await report(id)).items[0];
    expect((await change(id, item.id, { status: 'followed_up', accuracy_confirmed: true })).status).toBe(409);
    await change(id, item.id, { status: 'sent', accuracy_confirmed: true, sent_at: NOW - FORTNIGHT });
    expect((await change(id, item.id, { status: 'followed_up' })).status).toBe(400);
    expect((await change(id, item.id, { status: 'followed_up', accuracy_confirmed: true })).status).toBe(200);
    const current = await report(id);
    expect(current.items[0]).toMatchObject({ status: 'followed_up', followed_up_at: NOW, due: false });
    expect(current.due_count).toBe(0);
  });
  it.each(['removed', 'refused', 'escalated'])('stops reminders for %s and refuses to reopen sent', async status => {
    const id = await create(), item = (await report(id)).items[0];
    await change(id, item.id, { status: 'sent', accuracy_confirmed: true, sent_at: NOW - FORTNIGHT });
    expect((await change(id, item.id, { status })).status).toBe(200);
    expect((await report(id)).items[0]).toMatchObject({ status, due: false });
    expect((await report(id)).due_count).toBe(0);
    expect((await change(id, item.id, { status: 'sent', accuracy_confirmed: true })).status).toBe(409);
    expect((await report(id)).items[0].status).toBe(status);
  });
  it('rejects item IDs belonging to another case', async () => {
    const first = await create(), second = await create({ affected_name: 'Benny Lee' });
    const otherItem = (await report(second)).items[0];
    expect((await change(first, otherItem.id, { status: 'sent', accuracy_confirmed: true })).status).toBe(404);
    expect((await report(second)).items[0].sent_at).toBeNull();
    expect((await api('/api/takedowns/not-a-uuid')).status).toBe(404);
  });
  it('deletes only the selected case and all its item rows', async () => {
    const first = await create({ urls: ['https://example.com/fixture/one', 'https://example.com/fixture/two'] });
    const second = await create({ urls: ['https://example.com/fixture/other'] });
    const before = rowCounts();
    expect((await api(`/api/takedowns/${first}`, 'DELETE')).status).toBe(200);
    expect((await api(`/api/takedowns/${first}`)).status).toBe(404);
    expect((await report(second)).items).toHaveLength(1);
    const after = rowCounts();
    expect(Object.values(before).reduce((a, b) => a + b, 0) - Object.values(after).reduce((a, b) => a + b, 0)).toBe(3);
    expect((await api(`/api/takedowns/${second}`, 'DELETE')).status).toBe(200);
    expect(rowCounts()).toMatchObject({ takedown_cases: 0, takedown_items: 0 });
    // Anonymous daily counters survive deletion, matching the scanner's limit.
    expect(rowCounts().ip_daily).toBe(1);
  });
});
