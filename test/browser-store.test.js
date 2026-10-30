import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserStore } from '../src/browser-store.js';

let indexedDB, first, second;
beforeEach(() => {
  indexedDB = new IDBFactory();
  first = createBrowserStore({ indexedDB, name: 'private-record-tests' });
  second = createBrowserStore({ indexedDB, name: 'private-record-tests' });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Browser persistence must never contact a server'); }));
});
afterEach(() => {
  try { expect(fetch).not.toHaveBeenCalled(); }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

describe('IndexedDB private record transactions', () => {
  it('commits records across independent store instances and isolates record kinds', async () => {
    const source = { id: 'shared', full_name: 'Synthetic Subject', nested: { value: 1 } };
    await first.put('scan', source.id, source);
    source.nested.value = 99;
    await second.put('case', source.id, { id: source.id, reporter_name: 'Synthetic Reporter' });
    expect(await second.get('scan', source.id)).toEqual({ id: 'shared', full_name: 'Synthetic Subject', nested: { value: 1 } });
    expect(await first.list('case')).toEqual([{ kind: 'case', id: 'shared', reporter_name: 'Synthetic Reporter' }]);
    expect(await second.list()).toHaveLength(2);
    const reopened = createBrowserStore({ indexedDB, name: 'private-record-tests' });
    expect(await reopened.get('case', source.id)).toEqual({ id: 'shared', reporter_name: 'Synthetic Reporter' });
  });
  it('waits for transaction commit rather than treating request success as a saved record', async () => {
    const original = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (...args) {
      const request = original.apply(this, args);
      request.addEventListener('success', () => request.transaction.abort());
      return request;
    });
    await expect(first.put('scan', 'not-committed', { id: 'not-committed' })).rejects.toThrow(/Browser storage/);
    spy.mockRestore();
    expect(await second.get('scan', 'not-committed')).toBeUndefined();
  });
  it('rolls back mutations when the synchronous mutator fails', async () => {
    await first.put('case', 'one', { id: 'one', nested: { status: 'ready' } });
    await expect(second.update('case', 'one', record => {
      record.nested.status = 'sent';
      throw new Error('Synthetic validation failed');
    })).rejects.toThrow('Synthetic validation failed');
    expect(await first.get('case', 'one')).toEqual({ id: 'one', nested: { status: 'ready' } });
    await second.update('case', 'one', record => ({ ...record, nested: { status: 'removed' } }));
    expect((await first.get('case', 'one')).nested.status).toBe('removed');
  });
  it('rejects asynchronous mutators without changing the committed record', async () => {
    await first.put('scan', 'one', { count: 1 });
    await expect(first.update('scan', 'one', async record => ({ count: record.count + 1 }))).rejects.toThrow(/synchronous/);
    expect(await second.get('scan', 'one')).toEqual({ count: 1 });
  });
  it('leaves previous data intact and reports quota failure without any network fallback', async () => {
    await first.put('case', 'one', { body: 'Original local draft' });
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('Synthetic browser quota exhausted', 'QuotaExceededError');
    });
    await expect(second.update('case', 'one', record => ({ ...record, body: 'Unsaved edited draft' }))).rejects.toMatchObject({ name: 'QuotaExceededError' });
    spy.mockRestore();
    expect(await first.get('case', 'one')).toEqual({ body: 'Original local draft' });
  });
  it('serializes concurrent read-modify-write updates across independent connections', async () => {
    await first.put('scan', 'counter', { count: 0, completed: [] });
    await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? first : second).update('scan', 'counter', record => ({
      count: record.count + 1, completed: [...record.completed, index],
    }))));
    const saved = await first.get('scan', 'counter');
    expect(saved.count).toBe(16);
    expect([...saved.completed].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, index) => index));
  });
  it('does not create missing records or resurrect a record after another instance deletes it', async () => {
    const mutate = vi.fn(record => ({ ...record, restored: true }));
    expect(await first.update('scan', 'never-created', mutate)).toBeUndefined();
    await first.put('scan', 'deleted', { id: 'deleted' });
    await second.remove('scan', 'deleted');
    expect(await first.update('scan', 'deleted', mutate)).toBeUndefined();
    expect(mutate).not.toHaveBeenCalled();
    expect(await first.list()).toEqual([]);
  });
  it('clear removes every local kind and subsequent stale updates cannot recreate them', async () => {
    await first.put('scan', 'one', { id: 'one' });
    await second.put('case', 'two', { id: 'two' });
    await first.clear();
    expect(await second.list()).toEqual([]);
    expect(await second.update('case', 'two', () => ({ id: 'two', restored: true }))).toBeUndefined();
    expect(await first.get('scan', 'one')).toBeUndefined();
  });
  it('fails visibly if IndexedDB is unavailable, without falling back to server storage', async () => {
    const unavailable = createBrowserStore({ indexedDB: null });
    await expect(unavailable.put('scan', 'one', { id: 'one' })).rejects.toThrow(/Nothing was saved to our server/);
    await expect(unavailable.get('scan', 'one')).rejects.toThrow(/Browser storage/);
  });
});
