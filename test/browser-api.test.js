import { describe, it, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createBrowserStore } from '../src/browser-store.js';
import { createBrowserApi } from '../src/browser-api.js';
import { readFileSync } from 'node:fs';

const input = { affected_name: 'Private Test', reporter_name: 'Private Test', reporter_email: 'private@example.com',
  role: 'self', age_at_creation: 'adult', authorised: true, shared_without_consent: true,
  urls: ['https://privacy-fixture.example/post'] };
const setup = () => {
  const indexedDB = new IDBFactory(), store = createBrowserStore({ indexedDB });
  const fetchImpl = vi.fn(() => { throw new Error('Unexpected network request'); });
  return { indexedDB, store, fetchImpl, ...createBrowserApi({ store, fetchImpl }) };
};
describe('browser API network boundary', () => {
  it('preserves demo identity and dated outcome history in case exports',async()=>{
    const app=setup();
    const {id}=await app.api('/api/takedowns',{method:'POST',body:{...input,is_demo:true}});
    await app.api(`/api/takedowns/${id}/items/1`,{method:'PATCH',body:{status:'removed'}});
    const exported=await app.reportData('case',id);
    expect(exported.is_demo).toBe(true);
    expect(exported.items[0].history).toEqual([expect.objectContaining({status:'removed',at:expect.any(Number)})]);
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });
  it('blocks native form navigation if the browser module cannot load', () => {
    const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
    expect(headers).toMatch(/form-action 'none'/);
    for (const [file, id] of [['contact.html', 'contact-submit'], ['takedowns.html', 'td-create-button']]) {
      const html = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
      expect(html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0]).toMatch(/\bdisabled\b/);
    }
  });
  it('creates, reloads, edits, tracks and deletes a case entirely inside IndexedDB', async () => {
    const app = setup();
    const { id } = await app.api('/api/takedowns', { method: 'POST', body: input });
    const path = `/api/takedowns/${id}`;
    expect((await app.listSaved())[0]).toMatchObject({ id, kind: 'case', label: 'Private Test' });
    await app.api(`${path}/items/1/draft`, { method: 'PATCH', body: { mode: 'initial', subject: 'My subject', body: 'My edited text' } });
    const reloaded = createBrowserApi({ store: createBrowserStore({ indexedDB: app.indexedDB }), fetchImpl: app.fetchImpl });
    expect((await reloaded.api(path)).items[0].draft).toMatchObject({ subject: 'My subject', body: 'My edited text' });
    await reloaded.api(`${path}/items/1`, { method: 'PATCH', body: { status: 'sent', accuracy_confirmed: true } });
    expect((await reloaded.api(path)).items[0].due_at).toBeGreaterThan(Date.now());
    await app.api(path, { method: 'DELETE' });
    await expect(reloaded.api(path)).rejects.toMatchObject({ status: 404 });
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });
  it('cannot read a case from another browser and never asks the server for it', async () => {
    const first = setup(), second = setup();
    const { id } = await first.api('/api/takedowns', { method: 'POST', body: input });
    await expect(second.api(`/api/takedowns/${id}`)).rejects.toMatchObject({ status: 404 });
    expect(second.fetchImpl).not.toHaveBeenCalled();
  });
  it('never falls back to server storage when browser storage is unavailable', async () => {
    const fetchImpl = vi.fn();
    const app = createBrowserApi({ store: createBrowserStore({ indexedDB: null }), fetchImpl });
    await expect(app.api('/api/takedowns', { method: 'POST', body: input })).rejects.toThrow('Browser storage');
    await expect(app.listSaved()).rejects.toThrow('Browser storage');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each(['/api/help', '/api/unlock', '/api/import', '/api/unknown', 'https://evil.example/api/config', '/api/config?name=Private', '/api/config#private'])('fails closed for %s', async path => {
    const app = setup();
    await expect(app.api(path, { method: 'POST', body: input })).rejects.toMatchObject({ status: 404 });
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });
  it('serves support resources and clears records without network', async () => {
    const app = setup();
    expect((await app.api('/api/help-links')).links.length).toBeGreaterThan(0);
    await app.api('/api/takedowns', { method: 'POST', body: input });
    await app.clearLocalData();
    expect(await app.listSaved()).toEqual([]);
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });
  it('requires explicit contact consent and rejects local identifiers or unapproved attachments before network', async () => {
    const app = setup(), body = { name: 'Test', email: 'test@example.com', message: '', help_type: 'unsure' };
    for (const extra of [{}, { consent: 'true' }, { consent: true, scan_id: 'private-id' }, { consent: true, attachment: {} }, { consent: true, share_report: false, attachment: {} }]) {
      await expect(app.api('/api/assistance', { method: 'POST', body: { ...body, ...extra } })).rejects.toMatchObject({ status: 400 });
    }
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });
  it('only sends the explicitly submitted contact payload with same-origin session cookies and no referrer', async () => {
    const app = setup(), body = { name: 'Test', email: 'test@example.com', message: 'Please help', help_type: 'unsure', consent: true, share_report: false };
    app.fetchImpl.mockResolvedValueOnce(Response.json({ storage: 'browser', bot_check_required: false }))
      .mockResolvedValueOnce(Response.json({ ok: true }, { status: 201 }));
    await app.api('/api/assistance', { method: 'POST', body });
    expect(app.fetchImpl).toHaveBeenCalledTimes(2);
    const [path, options] = app.fetchImpl.mock.calls[1];
    expect(path).toBe('/api/assistance');
    expect(options).toMatchObject({ method: 'POST', cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer' });
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(options.body)).toEqual(body);
  });
  it('sends only user-entered http(s) links and rejects malformed link lists before network', async () => {
    const app = setup(), body = { name: 'Test', email: 'test@example.com', message: 'Please help', help_type: 'unsure', consent: true };
    for (const links of ['https://t.me/x', [42], ['javascript:alert(1)'], Array.from({ length: 21 }, (_, i) => `https://t.me/${i}`)]) {
      await expect(app.api('/api/assistance', { method: 'POST', body: { ...body, links } })).rejects.toMatchObject({ status: 400 });
    }
    expect(app.fetchImpl).not.toHaveBeenCalled();
    app.fetchImpl.mockResolvedValueOnce(Response.json({ storage: 'browser', bot_check_required: false }))
      .mockResolvedValueOnce(Response.json({ ok: true, delivered: true }, { status: 201 }));
    await app.api('/api/assistance', { method: 'POST', body: { ...body, links: ['https://t.me/+PrivateGroup'] } });
    expect(JSON.parse(app.fetchImpl.mock.calls[1][1].body).links).toEqual(['https://t.me/+PrivateGroup']);
  });
  it('rejects hidden nested fields or objects before sending a report attachment', async () => {
    const app = setup(), body = { name: 'Test', email: 'test@example.com', message: '', help_type: 'unsure', consent: true, share_report: true };
    const attachment = { subject_name: 'Test', subject_type: 'person', country: '', results: [{ url: 'https://fixture.example/post', title: 'Test' }] };
    for (const extra of [
      { attachment: { ...attachment, scan_id: 'private-local-id' } },
      { attachment: { ...attachment, results: [{ ...attachment.results[0], snippet: 'unpreviewed-text' }] } },
      { attachment: { ...attachment, country: { private: 'case data' } } },
      { name: { private: 'case data' }, attachment },
    ]) await expect(app.api('/api/assistance', { method: 'POST', body: { ...body, ...extra } })).rejects.toMatchObject({ status: 400 });
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });
  it('previews a saved scan locally without advancing the pipeline', async () => {
    const app = setup(), id = crypto.randomUUID();
    await app.store.put('scan', id, { id, full_name: 'Private Test', subject_type: 'person', context: { country: 'Singapore' },
      status: 'planning', provider: 'serpapi', hits: [{ id: 1, url: 'https://fixture.example/post', title: 'Test title', category: 'bad_review', severity: 2, identity_confidence: 0.8 }], queries: [] });
    expect(await app.assistancePreview(id, [1])).toEqual({ subject_name: 'Private Test', subject_type: 'person', country: 'Singapore', results: [{ url: 'https://fixture.example/post', title: 'Test title' }] });
    expect((await app.store.get('scan', id)).status).toBe('planning');
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });
  it('requires a browser-storage server and never submits scans to an older API', async () => {
    const app = setup();
    app.fetchImpl.mockResolvedValueOnce(Response.json({ provider: 'serpapi', storage: 'server' }));
    await expect(app.api('/api/config')).rejects.toMatchObject({ status: 503 });
    expect(app.fetchImpl.mock.calls.map(args => args[0])).toEqual(['/api/config']);
  });

  it('refreshes operator privileges after each completed configuration read without starting a search', async () => {
    const app = setup();
    app.fetchImpl.mockImplementationOnce(async () => Response.json({ storage: 'browser', operator: true }))
      .mockImplementationOnce(async () => Response.json({ storage: 'browser', operator: false }));
    expect((await app.api('/api/config')).operator).toBe(true);
    expect((await app.api('/api/config')).operator).toBe(false);
    expect(app.fetchImpl.mock.calls.map(([path]) => path)).toEqual(['/api/config', '/api/config']);
    expect(app.fetchImpl.mock.calls.every(([, options]) => options.credentials === 'same-origin')).toBe(true);
  });

  it('sends only an independent permit nonce and ticketed queries for a public scan', async () => {
    const app = setup();
    const expiry = Date.now() + 60_000;
    app.fetchImpl.mockImplementation(async path => {
      if (path === '/api/config') return Response.json({ storage: 'browser', provider: 'searxng', operator: false, search_relay_enabled: true, scan_ticket_required: true, max_queries: 1 });
      if (path === '/api/search-session') return Response.json({ search_ticket: 'opaque-permit', expires_at: expiry, reset_at: expiry, remaining_scans: 2, max_requests: 4 });
      if (path === '/api/search') return Response.json({ results: [], related: [] });
      throw new Error('Unexpected route');
    });
    const { id } = await app.api('/api/scan', { method: 'POST', body: { full_name: 'Example Person', email: 'private@example.com', is_minor: false, attestation: true, live_search_consent: true, context: { country_code: 'sg' } } });
    await app.api(`/api/scan/${id}`);
    expect(app.fetchImpl.mock.calls.every(([path]) => path === '/api/config')).toBe(true);
    expect((await app.api(`/api/scan/${id}`)).status).toBe('done');
    const starts = app.fetchImpl.mock.calls.filter(([path]) => path === '/api/search-session');
    expect(starts).toHaveLength(1);
    const payload = JSON.parse(starts[0][1].body);
    expect(Object.keys(payload)).toEqual(['request_id']); expect(payload.request_id).not.toBe(id);
    const searches = app.fetchImpl.mock.calls.filter(([path]) => path === '/api/search');
    expect(searches).toHaveLength(1);
    expect(JSON.parse(searches[0][1].body)).toEqual({ q: '"Example Person"', country_code: '', kind: 'search', search_ticket: 'opaque-permit' });
    expect(JSON.stringify(app.fetchImpl.mock.calls)).not.toContain('private@example.com');
    expect(JSON.stringify(app.fetchImpl.mock.calls)).not.toContain(id);
  });

  it.each([true, undefined])('transmits SerpApi backup permission only when explicitly saved with the available provider: %s', async consent => {
    const app = setup(), expiry = Date.now() + 60_000;
    app.fetchImpl.mockImplementation(async path => {
      if (path === '/api/config') return Response.json({ storage: 'browser', provider: 'searxng', operator: false,
        search_relay_enabled: true, scan_ticket_required: true, max_queries: 1,
        google_backup_provider: 'serpapi', google_backup_available: true });
      if (path === '/api/search-session') return Response.json({ search_ticket: 'opaque-permit', expires_at: expiry,
        reset_at: expiry, remaining_scans: 2, max_requests: 4 });
      if (path === '/api/search') return Response.json({ results: [], related: [], coverage: { returned: 0,
        invalid: 0, limited: 0, engines: [], ...(consent ? { google_recovery: 'empty', attempts: 2, google_backup_provider: 'serpapi' } : {}) } });
      throw new Error('Unexpected route');
    });
    const { id } = await app.api('/api/scan', { method: 'POST', body: { full_name: 'Example Person', email: 'private@example.com',
      is_minor: false, attestation: true, live_search_consent: true, ...(consent ? { google_backup_consent: true } : {}) } });
    await app.api(`/api/scan/${id}`);
    const report = await app.api(`/api/scan/${id}`);
    const searches = app.fetchImpl.mock.calls.filter(([path]) => path === '/api/search');
    expect(searches).toHaveLength(1);
    expect(JSON.parse(searches[0][1].body)).toEqual({ q: '"Example Person"', country_code: '', kind: 'search',
      search_ticket: 'opaque-permit', ...(consent ? { google_backup_consent: true } : {}) });
    expect(report.google_backup_consent).toBe(consent === true);
    const exported = await app.reportData('scan', id);
    expect(exported).toMatchObject({ google_backup_consent: consent === true, configured_google_backup_provider: 'serpapi' });
    expect(JSON.stringify(app.fetchImpl.mock.calls)).not.toContain('private@example.com');
    expect(JSON.stringify(app.fetchImpl.mock.calls)).not.toContain(id);
  });

  it('checks explicit contact sends using only a fixed action and public site key and never reuses tokens', async () => {
    const app = setup(), challenge = vi.fn().mockResolvedValueOnce('one-use-1').mockResolvedValueOnce('one-use-2');
    app.setChallengeHandler(challenge);
    const body = { name: 'Private Name', email: 'private@example.com', message: 'Private message', help_type: 'unsure', consent: true };
    app.fetchImpl.mockImplementation(async path => path === '/api/config'
      ? Response.json({ storage: 'browser', bot_check_required: true, bot_check_configured: true, turnstile_site_key: 'public-key' })
      : Response.json({ ok: true }));
    expect(challenge).not.toHaveBeenCalled();
    await app.api('/api/assistance', { method: 'POST', body });
    await app.api('/api/assistance', { method: 'POST', body });
    expect(challenge.mock.calls.map(([options]) => options)).toEqual([
      { action: 'assistance', sitekey: 'public-key' }, { action: 'assistance', sitekey: 'public-key' },
    ]);
    expect(app.fetchImpl.mock.calls.filter(([path]) => path === '/api/assistance').map(([, options]) => JSON.parse(options.body).challenge_token)).toEqual(['one-use-1', 'one-use-2']);
    expect(await app.store.list()).toEqual([]);
  });

  it('fails closed before challenge loading or contact transmission when the check is unconfigured', async () => {
    const app = setup(), challenge = vi.fn(); app.setChallengeHandler(challenge);
    app.fetchImpl.mockResolvedValue(Response.json({ storage: 'browser', bot_check_required: true, bot_check_configured: false, turnstile_site_key: null }));
    await expect(app.api('/api/assistance', { method: 'POST', body: { name: 'Test', email: 'test@example.com', message: '', help_type: 'unsure', consent: true } })).rejects.toMatchObject({ status: 503, code: 'bot_check_unavailable' });
    expect(challenge).not.toHaveBeenCalled(); expect(app.fetchImpl.mock.calls.map(([path]) => path)).toEqual(['/api/config']);
  });

  it.each([{ operator: true, bot_check_required: false }, { operator: false, bot_check_required: false }])('does not load a challenge when configuration does not require it: %j', async settings => {
    const app = setup(), challenge = vi.fn(); app.setChallengeHandler(challenge);
    app.fetchImpl.mockImplementation(async path => Response.json(path === '/api/config' ? { storage: 'browser', ...settings } : { ok: true }));
    await app.api('/api/assistance', { method: 'POST', body: { name: 'Test', email: 'test@example.com', message: '', help_type: 'unsure', consent: true } });
    expect(challenge).not.toHaveBeenCalled();
    expect(JSON.parse(app.fetchImpl.mock.calls[1][1].body)).not.toHaveProperty('challenge_token');
  });

  it('recovers an issued permit after a lost response without challenging again or exposing local fields', async () => {
    const app = setup(), challenge = vi.fn(async () => 'transient-token'); app.setChallengeHandler(challenge);
    const expiry = Date.now() + 60000;
    const cfg = { storage: 'browser', provider: 'searxng', operator: false, search_relay_enabled: true, scan_ticket_required: true,
      max_queries: 1, bot_check_required: true, bot_check_configured: true, turnstile_site_key: 'public-key' };
    let starts = 0;
    app.fetchImpl.mockImplementation(async path => {
      if (path === '/api/config') return Response.json(cfg);
      if (path === '/api/search-session') {
        if (++starts === 1) throw new Error('lost response');
        return Response.json({ search_ticket: 'opaque-permit', expires_at: expiry, reset_at: expiry, remaining_scans: 2, max_requests: 4 });
      }
      return Response.json({ results: [], related: [] });
    });
    const { id } = await app.api('/api/scan', { method: 'POST', body: { full_name: 'Private Person', email: 'private@example.com', is_minor: false, attestation: true, live_search_consent: true } });
    await app.api(`/api/scan/${id}`); expect(challenge).not.toHaveBeenCalled();
    expect((await app.api(`/api/scan/${id}`)).status).toBe('error');
    await app.api(`/api/scan/${id}/retry`, { method: 'POST' });
    expect((await app.api(`/api/scan/${id}`)).status).toBe('done');
    const calls = app.fetchImpl.mock.calls.filter(([path]) => path === '/api/search-session').map(([, options]) => JSON.parse(options.body));
    expect(calls[0]).toEqual({ request_id: calls[1].request_id, challenge_token: 'transient-token' });
    expect(Object.keys(calls[1])).toEqual(['request_id']);
    expect(challenge).toHaveBeenCalledOnce();
    expect(challenge).toHaveBeenCalledWith({ action: 'scan_start', sitekey: 'public-key' });
    expect(JSON.stringify(await app.store.list())).not.toContain('transient-token');
  });

  it('does not mint a permit after a scan is deleted while the challenge is open', async () => {
    const app = setup(); let resolveChallenge, started;
    const waiting = new Promise(resolve => { started = resolve; });
    app.setChallengeHandler(() => { started(); return new Promise(resolve => { resolveChallenge = resolve; }); });
    app.fetchImpl.mockImplementation(async () => Response.json({ storage: 'browser', provider: 'searxng', operator: false, search_relay_enabled: true, scan_ticket_required: true,
      max_queries: 1, bot_check_required: true, bot_check_configured: true, turnstile_site_key: 'public-key' }));
    const { id } = await app.api('/api/scan', { method: 'POST', body: { full_name: 'Test Person', is_minor: false, attestation: true, live_search_consent: true } });
    await app.api(`/api/scan/${id}`);
    const running = app.api(`/api/scan/${id}`), rejection = expect(running).rejects.toMatchObject({ status: 404 }); await waiting;
    await app.api(`/api/scan/${id}`, { method: 'DELETE' }); resolveChallenge('unused-token'); await rejection;
    expect(app.fetchImpl.mock.calls.every(([path]) => path === '/api/config')).toBe(true);
    expect(await app.store.get('scan', id)).toBeUndefined();
  });

  it('gets a fresh challenge after retrying a nonce that has no issued permit', async () => {
    const app = setup(), challenge = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Cancelled'), { status: 403, code: 'bot_check_cancelled' })).mockResolvedValueOnce('fresh-proof');
    app.setChallengeHandler(challenge);
    const expiry = Date.now() + 60000;
    app.fetchImpl.mockImplementation(async (path, options) => {
      if (path === '/api/config') return Response.json({ storage: 'browser', provider: 'searxng', operator: false, search_relay_enabled: true, scan_ticket_required: true,
        max_queries: 1, bot_check_required: true, bot_check_configured: true, turnstile_site_key: 'public-key' });
      if (path === '/api/search-session') return JSON.parse(options.body).challenge_token
        ? Response.json({ search_ticket: 'permit', expires_at: expiry, reset_at: expiry, remaining_scans: 2, max_requests: 4 })
        : Response.json({ error: 'Security check required', code: 'bot_check_required' }, { status: 403 });
      return Response.json({ results: [], related: [] });
    });
    const { id } = await app.api('/api/scan', { method: 'POST', body: { full_name: 'Test Person', is_minor: false, attestation: true, live_search_consent: true } });
    await app.api(`/api/scan/${id}`);
    expect((await app.api(`/api/scan/${id}`)).error_code).toBe('bot_check_cancelled');
    expect(app.fetchImpl.mock.calls.some(([path]) => path === '/api/search-session')).toBe(false);
    await app.api(`/api/scan/${id}/retry`, { method: 'POST' });
    expect((await app.api(`/api/scan/${id}`)).status).toBe('done');
    const permits = app.fetchImpl.mock.calls.filter(([path]) => path === '/api/search-session').map(([, options]) => JSON.parse(options.body));
    expect(permits).toHaveLength(2); expect(permits[0]).toEqual({ request_id: permits[1].request_id });
    expect(permits[1].challenge_token).toBe('fresh-proof'); expect(challenge).toHaveBeenCalledTimes(2);
  });
});
