// Synthetic browser-service check with isolated IndexedDB; never contacts a server.
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { createBrowserStore } from '../src/browser-store.js';
import { createBrowserApi } from '../src/browser-api.js';
const indexedDB = new IDBFactory();
const make = () => createBrowserApi({ store: createBrowserStore({ indexedDB }), fetchImpl: () => { throw new Error('Unexpected network request'); } });
let app = make();
const { id } = await app.api('/api/takedowns', { method: 'POST', body: {
  affected_name: 'Synthetic Example', reporter_name: 'Synthetic Example', reporter_email: 'test@example.com', role: 'self',
  age_at_creation: 'adult', authorised: true, shared_without_consent: true, urls: ['https://fixture.example/post'],
} });
const path = `/api/takedowns/${id}`;
await app.api(`${path}/items/1/draft`, { method: 'PATCH', body: { mode: 'initial', subject: 'Edited', body: 'Local test draft' } });
await app.api(`${path}/items/1`, { method: 'PATCH', body: { status: 'sent', accuracy_confirmed: true, sent_at: Date.now() - 15 * 86400000 } });
app = make();
const reloaded = await app.api(path);
assert.equal(reloaded.items[0].draft.body, 'Local test draft');
assert.equal(reloaded.due_count, 1);
await app.api(path, { method: 'DELETE' });
await assert.rejects(app.api(path), { status: 404 });
console.log('PASS: browser case creation, edited draft persistence, 14-day reminder, reload and deletion. No network.');
