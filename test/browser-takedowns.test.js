import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createBrowserTakedowns } from '../src/browser-takedowns.js';
import { FOLLOWUP_MS } from '../src/takedowns.js';
import { IDBFactory } from 'fake-indexeddb';
import { createBrowserStore } from '../src/browser-store.js';

const NOW = Date.UTC(2026, 8, 25, 12);
const base = {
  affected_name: 'Anne Lee', reporter_name: 'Anne Lee', reporter_email: 'anne@example.com',
  role: 'self', age_at_creation: 'adult', authorised: true, shared_without_consent: true,
  urls: ['https://example.com/fixture/post?token=a%2Fb&ref=original&utm_source=keep#media-2'],
};

// A shared store models separate tabs. Writes and synchronous mutators are
// serialised per key; mutators see a clone of the current committed record.
function memoryStore() {
  const records = new Map(), tails = new Map();
  const keyOf = (kind, id) => `${kind}:${id}`;
  const enqueue = (kind, id, operation) => {
    const key = keyOf(kind, id);
    const result = (tails.get(key) || Promise.resolve()).then(() => operation(key));
    tails.set(key, result.catch(() => {}));
    return result;
  };
  return {
    records,
    get: vi.fn(async (kind, id) => {
      const key = keyOf(kind, id);
      await (tails.get(key) || Promise.resolve());
      return structuredClone(records.get(key));
    }),
    put: vi.fn((kind, id, record) => enqueue(kind, id, key => records.set(key, structuredClone(record)))),
    remove: vi.fn((kind, id) => enqueue(kind, id, key => records.delete(key))),
    update: vi.fn((kind, id, mutator) => enqueue(kind, id, key => {
      if (!records.has(key)) return undefined;
      const updated = mutator(structuredClone(records.get(key)));
      if (updated?.then) throw new Error('Store mutators must be synchronous');
      records.set(key, structuredClone(updated));
      return structuredClone(updated);
    })),
  };
}

let store, handle, clock, sequence;
const path = id => `/api/takedowns/${id}`;
const create = async (extra = {}) => (await handle('/api/takedowns', { method: 'POST', body: { ...base, ...extra } })).id;
const report = id => handle(path(id));
const change = (id, itemId, body, service = handle) => service(`${path(id)}/items/${itemId}`, { method: 'PATCH', body });
const sent = { status: 'sent', accuracy_confirmed: true };
const edit = (id, itemId, body, service = handle) => service(`${path(id)}/items/${itemId}/draft`, { method: 'PATCH', body });

beforeEach(() => {
  clock = NOW; sequence = 0; store = memoryStore();
  handle = createBrowserTakedowns({ store, now: () => clock, uuid: () => `12345678-1234-4234-8234-${String(++sequence).padStart(12, '0')}` });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Browser takedown cases must never make a network request'); }));
});
afterEach(() => {
  try { expect(fetch).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); }
});

describe('browser-only known-URL cases', () => {
  it('creates and reads an adult case with local sequential items and exact content URLs', async () => {
    const urls = [base.urls[0], 'https://www.reddit.com/r/fixture/comments/example/?context=3', base.urls[0]];
    const id = await create({ urls });
    const result = await report(id);
    expect(result).toMatchObject({ id, created_at: NOW, authority_confirmed_at: NOW, due_count: 0, reporter_name: 'Anne Lee' });
    expect(result.items.map(item => item.id)).toEqual([1, 2]);
    expect(result.items.map(item => item.url)).toEqual(urls.slice(0, 2));
    for (const item of result.items) {
      expect(item).toMatchObject({ status: 'ready', sent_at: null, due_at: null, followed_up_at: null, due: false, reference: '' });
      expect(item.draft.body).toContain(item.url);
      expect(item.draft.body).toContain('anne@example.com');
      expect(item.draft.body).toContain('No images are attached.');
      expect(item.draft).toMatchObject({ subject: expect.any(String), followup_subject: expect.any(String), followup_body: expect.any(String) });
    }
    expect(result.items[0].channel.url).toBeNull();
    expect(result.items[1].channel.name).toBe('Reddit');
    expect(result.support_links.length).toBeGreaterThan(0);
    expect([...store.records.keys()]).toEqual([`case:${id}`]);
    expect(store.put).toHaveBeenCalledOnce();
    expect(store.records.get(`case:${id}`).items[0]).not.toHaveProperty('draft');
  });

  it('describes the reporting representative accurately without claiming they are the affected person', async () => {
    const id = await create({ role: 'representative', reporter_name: 'Casey Tan', reporter_email: 'casey@example.com' });
    const body = (await report(id)).items[0].draft.body;
    expect(body).toContain('I am Casey Tan, the authorised representative of Anne Lee.');
    expect(body).toContain('casey@example.com');
    expect(body).not.toContain('I am Casey Tan, the person affected');
  });

  it.each(['under18', 'unknown'])('returns specialist help before personal details for %s and writes nothing', async age => {
    const result = await handle('/api/takedowns', { method: 'POST', body: { age_at_creation: age } });
    expect(result).toMatchObject({ help_only: true, links: expect.any(Array), reason: expect.any(String) });
    expect(result.links.some(link => link.name.includes('Take It Down'))).toBe(true);
    expect(store.put).not.toHaveBeenCalled();
    expect(store.records.size).toBe(0);
    expect(store.get).not.toHaveBeenCalled();
  });

  it.each([
    { authorised: false }, { authorised: 'true' }, { shared_without_consent: undefined },
    { shared_without_consent: 'true' }, { role: 'unrelated' }, { age_at_creation: 'invalid' },
    { affected_name: '' }, { reporter_name: '' }, { reporter_email: 'invalid-email' },
  ])('rejects invalid authority, consent or reporter input without writing: %j', async invalid => {
    await expect(create(invalid)).rejects.toMatchObject({ status: 400 });
    expect(store.put).not.toHaveBeenCalled();
    expect(store.records.size).toBe(0);
  });

  it.each([
    'javascript:alert(1)', 'file:///tmp/photo.jpg', 'data:image/png;base64,AAAA',
    'https://person:password@example.com/private', 'http://127.0.0.1/photo.jpg',
    'http://localhost/media', 'http://10.0.0.1/post', 'http://192.168.1.10/post',
    'http://172.16.1.2/post', 'http://169.254.1.2/post', 'http://100.64.0.1/post',
    'http://[::1]/post', 'http://[fe80::1]/post', 'http://[::ffff:192.168.1.2]/post',
  ])('rejects unsafe URL %s before persisting any case', async url => {
    await expect(create({ urls: [base.urls[0], url] })).rejects.toMatchObject({ status: 400 });
    expect(store.put).not.toHaveBeenCalled();
  });

  it('requires one to twenty-five URLs and validates request body shape', async () => {
    for (const urls of [[], Array.from({ length: 26 }, (_, i) => `https://example.com/fixture/${i}`)]) {
      await expect(create({ urls })).rejects.toMatchObject({ status: 400 });
    }
    for (const body of [undefined, null, [], 'not an object']) {
      await expect(handle('/api/takedowns', { method: 'POST', body })).rejects.toMatchObject({ status: 400 });
    }
    expect(store.put).not.toHaveBeenCalled();
  });

  it('never assigns a verified platform route to a lookalike host', async () => {
    const id = await create({ urls: ['https://reddit.com.attacker.example/post', 'https://notinstagram.com/post', 'https://www.x.com/post'] });
    const items = (await report(id)).items;
    expect(items[0].channel.url).toBeNull();
    expect(items[1].channel.url).toBeNull();
    expect(items[0].channel.instructions).toContain('no verified reporting route');
    expect(items[2].channel.name).toBe('X');
  });

  it('starts the reminder only after confirmed sending and marks it due at exactly fourteen days', async () => {
    const id = await create();
    await expect(change(id, 1, { status: 'sent' })).rejects.toMatchObject({ status: 400 });
    expect((await report(id)).items[0].sent_at).toBeNull();
    await change(id, 1, { ...sent, sent_at: NOW, reference: 'Receipt ABC' });
    clock = NOW + FOLLOWUP_MS - 1;
    expect((await report(id)).items[0]).toMatchObject({ sent_at: NOW, due_at: NOW + FOLLOWUP_MS, reference: 'Receipt ABC', due: false });
    clock++;
    const current = await report(id);
    expect(current.items[0].due).toBe(true);
    expect(current.due_count).toBe(1);
    expect(current.items[0].draft.followup_body).toContain('Receipt ABC');
    expect(current.items[0].draft.followup_body).toContain('2026-09-25');
  });

  it('accepts historical dates but rejects future or invalid timestamps without changing storage', async () => {
    const id = await create();
    for (const sent_at of [NOW + 1, 'yesterday', -1, 0, 1.5]) {
      await expect(change(id, 1, { ...sent, sent_at })).rejects.toMatchObject({ status: 400 });
      expect((await report(id)).items[0].sent_at).toBeNull();
    }
    await change(id, 1, { ...sent, sent_at: NOW - FOLLOWUP_MS });
    expect((await report(id)).items[0]).toMatchObject({ sent_at: NOW - FOLLOWUP_MS, due_at: NOW, due: true });
  });

  it('preserves original sending time and a newly recorded reference across duplicate sends from different tabs', async () => {
    const id = await create();
    const secondTab = createBrowserTakedowns({ store, now: () => NOW });
    const stale = await secondTab(path(id));
    expect(stale.items[0].sent_at).toBeNull();
    store.get.mockClear();
    const original = NOW - FOLLOWUP_MS;
    await Promise.all([
      change(id, 1, { ...sent, sent_at: original, reference: 'Receipt ABC' }),
      change(id, 1, { ...sent, sent_at: NOW }, secondTab),
    ]);
    // No read-then-write outside the transaction is used for PATCH.
    expect(store.get).not.toHaveBeenCalled();
    const current = (await report(id)).items[0];
    expect(current).toMatchObject({ sent_at: original, due_at: original + FOLLOWUP_MS, reference: 'Receipt ABC', due: true });
  });

  it('does not reopen a report when a stale sent action races with removal', async () => {
    const id = await create();
    await change(id, 1, { ...sent, sent_at: NOW - FOLLOWUP_MS });
    const outcomes = await Promise.allSettled([
      change(id, 1, { status: 'removed' }),
      change(id, 1, sent),
    ]);
    expect(outcomes[0]).toMatchObject({ status: 'fulfilled', value: { ok: true } });
    expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect((await report(id)).items[0]).toMatchObject({ status: 'removed', due: false });
  });

  it('requires original sending and confirmation before follow-up and preserves the first follow-up date', async () => {
    const id = await create(), followup = { status: 'followed_up', accuracy_confirmed: true };
    await expect(change(id, 1, followup)).rejects.toMatchObject({ status: 409 });
    await change(id, 1, { ...sent, sent_at: NOW - FOLLOWUP_MS });
    await expect(change(id, 1, { status: 'followed_up' })).rejects.toMatchObject({ status: 400 });
    await change(id, 1, followup);
    clock++;
    await change(id, 1, followup);
    expect((await report(id)).items[0]).toMatchObject({ status: 'followed_up', followed_up_at: NOW, due: false });
    await expect(change(id, 1, sent)).rejects.toMatchObject({ status: 409 });
  });

  it.each(['removed', 'refused', 'escalated'])('stops reminders for %s and refuses reopening', async status => {
    const id = await create();
    await change(id, 1, { ...sent, sent_at: NOW - FOLLOWUP_MS });
    await change(id, 1, { status });
    expect((await report(id)).due_count).toBe(0);
    await expect(change(id, 1, sent)).rejects.toMatchObject({ status: 409 });
    await expect(change(id, 1, { status: 'followed_up', accuracy_confirmed: true })).rejects.toMatchObject({ status: 409 });
    expect((await report(id)).items[0].status).toBe(status);
  });

  it('isolates cases, uses item IDs only inside the requested case, and deletes one case with all its items', async () => {
    const first = await create(), second = await create({ affected_name: 'Benny Lee', urls: ['https://example.com/one', 'https://example.com/two'] });
    await expect(change(first, 2, sent)).rejects.toMatchObject({ status: 404 });
    await change(second, 2, sent);
    expect((await report(first)).items[0].status).toBe('ready');
    expect((await report(second)).items.map(item => item.status)).toEqual(['ready', 'sent']);
    expect(await handle(path(second), { method: 'DELETE' })).toEqual({ deleted: true });
    await expect(report(second)).rejects.toMatchObject({ status: 404 });
    await expect(change(second, 1, sent)).rejects.toMatchObject({ status: 404 });
    expect(store.records.size).toBe(1);
    expect((await report(first)).items).toHaveLength(1);
    expect(store.records.has(`case:${second}`)).toBe(false);
  });

  it('does not resurrect a deleted case when a queued PATCH arrives after removal', async () => {
    const id = await create();
    await store.remove('case', id);
    await expect(change(id, 1, sent)).rejects.toMatchObject({ status: 404 });
    expect(store.records.size).toBe(0);
    expect(store.put).toHaveBeenCalledOnce();
  });

  it('rejects unknown routes, IDs and methods without writes', async () => {
    const id = await create();
    for (const [route, method] of [
      ['/api/takedowns', 'GET'], ['/api/takedowns/not-a-uuid', 'GET'],
      ['/api/takedowns/12345678-1234-4234-8234-999999999999', 'GET'],
      [`${path(id)}/items/0`, 'PATCH'], [`${path(id)}/items/999999999999999999`, 'PATCH'],
      [path(id), 'PUT'], [`${path(id)}/items/1`, 'DELETE'], [`${path(id)}/unknown`, 'GET'],
    ]) {
      await expect(handle(route, { method, body: sent })).rejects.toMatchObject({ status: 404 });
    }
    expect(store.put).toHaveBeenCalledOnce();
    expect(store.update).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('persists exact edited drafts across IndexedDB connections and service reloads', async () => {
    const indexedDB = new IDBFactory(), name = 'local-draft-reload';
    const local = createBrowserStore({ indexedDB, name });
    handle = createBrowserTakedowns({ store: local, now: () => clock });
    const id = await create();
    const original = (await report(id)).items[0];
    const initial = { mode: 'initial', subject: '  My reviewed subject  ', body: 'My reviewed request.\n\nKeep this spacing.\n' };
    expect(await edit(id, 1, initial)).toEqual({ ok: true });
    const reloaded = createBrowserTakedowns({ store: createBrowserStore({ indexedDB, name }), now: () => clock });
    let item = (await reloaded(path(id))).items[0];
    expect(item.draft).toMatchObject({ subject: initial.subject, body: initial.body, followup_subject: original.draft.followup_subject, followup_body: original.draft.followup_body });
    expect(item).toMatchObject({ status: 'ready', sent_at: null, due_at: null, followed_up_at: null });
    const followup = { mode: 'followup', subject: 'Follow-up subject', body: 'My reviewed follow-up.' };
    await edit(id, 1, followup, reloaded);
    item = (await report(id)).items[0];
    expect(item.draft).toEqual({ subject: initial.subject, body: initial.body, followup_subject: followup.subject, followup_body: followup.body });
    expect(item.status).toBe('ready');
  });

  it('merges concurrent initial, follow-up and sending updates without losing edits or status', async () => {
    const indexedDB = new IDBFactory(), name = 'local-draft-concurrency';
    handle = createBrowserTakedowns({ store: createBrowserStore({ indexedDB, name }), now: () => clock });
    const secondTab = createBrowserTakedowns({ store: createBrowserStore({ indexedDB, name }), now: () => clock });
    const id = await create();
    await Promise.all([
      edit(id, 1, { mode: 'initial', subject: 'Initial custom subject', body: 'Initial custom body' }),
      edit(id, 1, { mode: 'followup', subject: 'Follow-up custom subject', body: 'Follow-up custom body' }, secondTab),
      change(id, 1, { ...sent, reference: 'Saved reference' }, secondTab),
    ]);
    expect((await report(id)).items[0]).toMatchObject({ status: 'sent', sent_at: NOW, due_at: NOW + FOLLOWUP_MS, reference: 'Saved reference',
      draft: { subject: 'Initial custom subject', body: 'Initial custom body', followup_subject: 'Follow-up custom subject', followup_body: 'Follow-up custom body' } });
  });

  it.each([
    { mode: 'other', subject: 'Subject', body: 'Body' }, { mode: 'initial', body: 'Body' },
    { mode: 'initial', subject: 'Subject', body: null }, { mode: 'initial', subject: 23, body: 'Body' },
    { mode: 'initial', subject: 'x'.repeat(181), body: 'Body' },
    { mode: 'initial', subject: 'Subject', body: 'x'.repeat(20001) },
    { mode: 'initial', subject: 'Subject', body: 'Body', status: 'sent' },
  ])('rejects invalid draft edits without changing any stored case data: %j', async body => {
    const id = await create(), before = structuredClone(store.records.get(`case:${id}`));
    await expect(edit(id, 1, body)).rejects.toMatchObject({ status: 400 });
    expect(store.records.get(`case:${id}`)).toEqual(before);
    expect(store.update).not.toHaveBeenCalled();
  });

  it('allows blank in-progress draft edits and exact maximum lengths without changing status', async () => {
    const id = await create();
    await edit(id, 1, { mode: 'initial', subject: 'x'.repeat(180), body: 'x'.repeat(20000) });
    expect((await report(id)).items[0].draft.body).toHaveLength(20000);
    await edit(id, 1, { mode: 'initial', subject: '', body: '' });
    expect((await report(id)).items[0]).toMatchObject({ status: 'ready', draft: { subject: '', body: '' } });
  });

  it('returns 404 for a missing item and for autosave arriving after deletion without recreating a case', async () => {
    const indexedDB = new IDBFactory(), name = 'local-draft-deletion';
    const local = createBrowserStore({ indexedDB, name });
    handle = createBrowserTakedowns({ store: local, now: () => clock });
    const staleTab = createBrowserTakedowns({ store: createBrowserStore({ indexedDB, name }), now: () => clock });
    const id = await create(), draft = { mode: 'initial', subject: 'Stale', body: 'Not restored' };
    await expect(edit(id, 2, draft)).rejects.toMatchObject({ status: 404 });
    await staleTab(path(id));
    await handle(path(id), { method: 'DELETE' });
    await expect(edit(id, 1, draft, staleTab)).rejects.toMatchObject({ status: 404 });
    expect(await local.get('case', id)).toBeUndefined();
    expect(await local.list()).toEqual([]);
  });
});
