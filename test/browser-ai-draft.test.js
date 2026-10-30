import { describe, it, expect, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { createBrowserStore } from '../src/browser-store.js';
import { createBrowserApi } from '../src/browser-api.js';
import { aiDraftingNotice } from '../public/search-coverage.js';
import { aiConsentText } from '../public/ai-draft.js';

const AI_TEXT = `Subject: Request to review an inaccurate claim

Hello,

Please review the claim on this page. I believe it is inaccurate. [Explain the error.]

I confirm that the information in this request is accurate to the best of my knowledge.

[your name]
[your contact email]`;
const scanInput = { full_name: 'Private Person', email: 'private.person@example.test', is_minor: false, attestation: true,
  harm_types: ['scam_fraud'], context: { country_code: 'sg', city: 'Private City' } };
const caseInput = { affected_name: 'Private Affected', reporter_name: 'Private Reporter', reporter_email: 'reporter@example.test',
  role: 'self', age_at_creation: 'adult', authorised: true, shared_without_consent: true, urls: ['https://www.reddit.com/r/example/comments/known_post'] };

function setup({ enabled = true, draftResponse } = {}) {
  const indexedDB = new IDBFactory(), store = createBrowserStore({ indexedDB });
  const config = { storage: 'browser', provider: 'session', demo: false, search_relay_enabled: false, operator: false,
    bot_check_required: false, ai_drafting_enabled: enabled, ai_provider_name: enabled ? 'Anthropic (Claude)' : null };
  const fetchImpl = vi.fn(async (path, options) => {
    if (path === '/api/config') return Response.json(config);
    if (path === '/api/draft-ai') return draftResponse ? draftResponse(JSON.parse(options.body)) : Response.json({ draft: AI_TEXT, model: 'claude-sonnet-5', provider: 'anthropic' });
    throw new Error(`Unexpected network request: ${path}`);
  });
  return { indexedDB, store, fetchImpl, ...createBrowserApi({ store, fetchImpl }) };
}
async function scanWithHit(app) {
  const { id } = await app.api('/api/scan', { method: 'POST', body: scanInput });
  await app.api(`/api/scan/${id}`);
  const { queries } = await app.api(`/api/scan/${id}/queries`);
  await app.api(`/api/scan/${id}/import`, { method: 'POST', body: { results: [{ q: queries[0].q,
    items: [{ title: 'Private Person scam allegation', url: 'https://news.example/story?id=7', snippet: 'Private Person fraud complaint Singapore' }] }] } });
  const scan = await app.store.get('scan', id);
  const hit = scan.hits.find(item => item.category !== 'neutral') || scan.hits[0];
  const info = await app.api(`/api/hit/${hit.id}/draft`, { method: 'POST', scanId: id, body: {} });
  return { id, hit, template: info.templates[0].id };
}
const aiCalls = fetchImpl => fetchImpl.mock.calls.filter(([path]) => path === '/api/draft-ai');

describe('browser AI drafting path', () => {
  it('sends only the consented fields for one result and stores the returned draft locally only', async () => {
    const app = setup();
    const { id, hit, template } = await scanWithHit(app);
    const result = await app.api(`/api/hit/${hit.id}/draft-ai`, { method: 'POST', scanId: id,
      body: { consent: true, template, owns_content: false, sender_email: 'private.person@example.test', facts: 'The case was dismissed.' } });
    expect(aiCalls(app.fetchImpl)).toHaveLength(1);
    const [, options] = aiCalls(app.fetchImpl)[0];
    const sent = JSON.parse(options.body);
    expect(Object.keys(sent).sort()).toEqual(['consent', 'facts', 'platform', 'request_type', 'snippet', 'title', 'url']);
    expect(sent).toMatchObject({ consent: true, request_type: template, url: hit.url, title: hit.title, snippet: hit.snippet, facts: 'The case was dismissed.' });
    const wire = options.body;
    for (const value of [id, 'private.person@example.test', 'Private City']) expect(wire).not.toContain(value);
    expect(wire).not.toMatch(/"(?:scan_id|hit_id|id|full_name|email)"/);
    expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer' });

    // Name and email are filled in locally after the response.
    expect(result).toMatchObject({ model: 'claude-sonnet-5', provider: 'anthropic' });
    expect(result.draft).toMatchObject({ source: 'ai', subject: 'Request to review an inaccurate claim', template, hit_id: hit.id });
    expect(result.draft.body).toContain('Private Person\nprivate.person@example.test');
    expect(result.draft.body).not.toContain('[your name]');

    // Persisted in IndexedDB like a template draft, reloadable from a fresh connection.
    const reloaded = createBrowserApi({ store: createBrowserStore({ indexedDB: app.indexedDB }), fetchImpl: app.fetchImpl });
    const saved = (await reloaded.api(`/api/hit/${hit.id}/draft`, { method: 'POST', scanId: id, body: { template, sender_email: 'private.person@example.test' } })).draft;
    expect(saved).toMatchObject({ source: 'ai', body: result.draft.body });
    await reloaded.api(`/api/hit/${hit.id}/draft`, { method: 'PATCH', scanId: id, body: { draft_id: saved.id, subject: saved.subject, body: 'My checked AI text' } });
    expect((await app.store.get('scan', id)).drafts.find(draft => draft.id === saved.id)).toMatchObject({ source: 'ai', body: 'My checked AI text' });
    // The only network traffic is configuration and this one draft request.
    expect(new Set(app.fetchImpl.mock.calls.map(([path]) => path))).toEqual(new Set(['/api/config', '/api/draft-ai']));
  });
  it('sends nothing without consent, when disabled, or with oversized facts', async () => {
    const app = setup();
    const { id, hit, template } = await scanWithHit(app);
    for (const consent of [undefined, false, 'true']) {
      await expect(app.api(`/api/hit/${hit.id}/draft-ai`, { method: 'POST', scanId: id, body: { consent, template } })).rejects.toMatchObject({ status: 400 });
    }
    await expect(app.api(`/api/hit/${hit.id}/draft-ai`, { method: 'POST', scanId: id, body: { consent: true, template, facts: 'x'.repeat(2001) } })).rejects.toMatchObject({ status: 400 });
    await expect(app.api(`/api/hit/${hit.id}/draft-ai`, { method: 'POST', scanId: id, body: { consent: true, template, remember: true } })).rejects.toMatchObject({ status: 400 });
    expect(aiCalls(app.fetchImpl)).toHaveLength(0);
    const disabled = setup({ enabled: false });
    const other = await scanWithHit(disabled);
    await expect(disabled.api(`/api/hit/${other.hit.id}/draft-ai`, { method: 'POST', scanId: other.id, body: { consent: true, template: other.template } }))
      .rejects.toMatchObject({ status: 403, code: 'ai_drafting_disabled' });
    expect(aiCalls(disabled.fetchImpl)).toHaveLength(0);
  });
  it('keeps existing drafts when the server falls back and passes its message through', async () => {
    const app = setup({ draftResponse: () => Response.json({ error: 'Today’s AI drafting budget has been used. Use the template draft instead, or try again after 00:00 UTC.', code: 'ai_budget_exhausted', fallback: 'template' }, { status: 429 }) });
    const { id, hit, template } = await scanWithHit(app);
    const before = (await app.store.get('scan', id)).drafts;
    await expect(app.api(`/api/hit/${hit.id}/draft-ai`, { method: 'POST', scanId: id, body: { consent: true, template } }))
      .rejects.toMatchObject({ status: 429, code: 'ai_budget_exhausted', message: expect.stringMatching(/template/) });
    expect((await app.store.get('scan', id)).drafts).toEqual(before);
    const templateDraft = await app.api(`/api/hit/${hit.id}/draft`, { method: 'POST', scanId: id, body: { template } });
    expect(templateDraft.draft.source).toBe('template');
  });
  it('drafts a known-URL intimate-image request with only the link and platform, stored in the local case', async () => {
    const app = setup();
    const { id } = await app.api('/api/takedowns', { method: 'POST', body: caseInput });
    const result = await app.api(`/api/takedowns/${id}/items/1/draft-ai`, { method: 'POST', body: { consent: true, facts: 'Posted without my consent last week.' } });
    const sent = JSON.parse(aiCalls(app.fetchImpl)[0][1].body);
    expect(sent).toEqual({ consent: true, request_type: 'intimate_image', url: caseInput.urls[0], platform: 'Reddit', facts: 'Posted without my consent last week.' });
    expect(aiCalls(app.fetchImpl)[0][1].body).not.toMatch(/Private Affected|Private Reporter|reporter@example\.test/);
    expect(result.draft).toMatchObject({ source: 'ai' });
    expect(result.draft.body).toContain('Private Reporter\nreporter@example.test');
    const item = (await app.api(`/api/takedowns/${id}`)).items[0];
    expect(item.draft).toMatchObject({ source: 'ai', body: result.draft.body });
    await app.api(`/api/takedowns/${id}/items/1/draft`, { method: 'PATCH', body: { mode: 'initial', subject: 'Edited', body: 'Edited text' } });
    expect((await app.api(`/api/takedowns/${id}`)).items[0].draft).toMatchObject({ source: 'ai', body: 'Edited text' });
    await expect(app.api(`/api/takedowns/${id}/items/1/draft-ai`, { method: 'POST', body: { facts: 'x' } })).rejects.toMatchObject({ status: 400 });
    expect(aiCalls(app.fetchImpl)).toHaveLength(1);
  });
  it('allows the AI route through the browser network boundary only via its consent-checked path', () => {
    const source = readFileSync(new URL('../src/browser-api.js', import.meta.url), 'utf8');
    expect(source).toContain("'/api/draft-ai'");
    expect(readFileSync(new URL('../public/local-api.js', import.meta.url), 'utf8')).not.toMatch(/AI_API_KEY|x-api-key|api\.anthropic\.com/);
  });
});

describe('AI drafting copy', () => {
  it('uses the configured provider name in dynamic copy and a neutral wording in static HTML', () => {
    expect(aiDraftingNotice({ ai_drafting_enabled: true, ai_provider_name: 'Anthropic (Claude)' }))
      .toContain('AI drafting is optional: if you choose “Draft with AI”, the details of that one result are sent to Anthropic (Claude) to write a draft. Nothing else is sent, and we don’t store it.');
    expect(aiDraftingNotice({ ai_drafting_enabled: false })).toMatch(/our AI provider.*currently switched off/);
    const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    expect(index).not.toContain('No cloud AI is used');
    expect(index).toContain('the details of that one result are sent to our AI provider to write a draft. Nothing else is sent, and we don’t store it.');
    expect(aiConsentText('Anthropic (Claude)')).toBe('This sends the details of this one result — its title, link, snippet, the platform, the request type and anything you type below — to our server and then to Anthropic (Claude) to write a draft. We don\'t store it. Your other results stay in your browser.');
  });
});
