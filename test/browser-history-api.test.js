import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createBrowserStore } from '../src/browser-store.js';
import { createBrowserApi } from '../src/browser-api.js';

const NOW = Date.UTC(2026, 8, 30, 12), OBSERVED = NOW - 86_400_000;
const ID = '12345678-1234-4234-8234-123456789abc';
function finding(index = 1, overrides = {}) {
  return { id: index, url: `https://publisher.example/private-path-${index}`, title: `Private title ${index}`,
    snippet: 'PRIVATE-SNIPPET', source_query: 'PRIVATE-QUERY', context_text: 'PRIVATE-SOURCE-TEXT',
    category: 'scam_fraud', severity: 3, match_confidence: 0.8, classified: 1, kind: 'web', status: 'sent',
    created_at: OBSERVED, discovery_origin: 'previous_scan', previous_scan_id: 'PRIVATE-PREVIOUS-SCAN',
    previous_hit_id: 500 + index, previous_observed_at: OBSERVED, last_seen_at: OBSERVED, carried_into_at: NOW,
    history: [{ status: 'sent', at: OBSERVED + 1000 }], ...overrides };
}
const row = (overrides = {}) => ({ id: ID, full_name: 'Synthetic Subject', subject_type: 'person', is_minor: false,
  context: { country: 'Singapore', country_code: 'sg' }, created_at: NOW, provider: 'searxng', status: 'planning',
  hits: [finding()], queries: [], drafts: [{ id: 1, hit_id: 1, body: 'PRIVATE-DRAFT' }], show_limit: 10, ...overrides });
async function setup(record = row()) {
  const store = createBrowserStore({ indexedDB: new IDBFactory(), name: 'synthetic-history-export' });
  await store.put('scan', ID, record);
  const fetchImpl = vi.fn(() => { throw new Error('Unexpected network request from historical export.'); });
  return { store, fetchImpl, ...createBrowserApi({ store, fetchImpl }) };
}

describe('historical finding export network boundary', () => {
  it('exports only the selected provenance dates without running a planning scan or sharing private content', async () => {
    const app = await setup(), data = await app.reportData('scan', ID);
    expect(data.items[0]).toMatchObject({ discovery_origin: 'previous_scan', previous_observed_at: OBSERVED,
      last_seen_at: OBSERVED, carried_into_at: NOW, status: 'sent', history: [{ status: 'sent', at: OBSERVED + 1000 }] });
    const serialized = JSON.stringify(data);
    for (const secret of ['PRIVATE-PREVIOUS-SCAN', 'previous_hit_id', 'PRIVATE-SNIPPET', 'PRIVATE-QUERY', 'PRIVATE-SOURCE-TEXT', 'PRIVATE-DRAFT']) {
      expect(serialized).not.toContain(secret);
    }
    expect((await app.store.get('scan', ID)).status).toBe('planning');
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps the ten-result allowance and excludes sensitive findings from export', async () => {
    const app = await setup(row({ hits: [...Array.from({ length: 11 }, (_, index) => finding(index + 1)),
      finding(99, { category: 'sensitive_intimate', title: 'SENSITIVE-SECRET', severity: 5 })] }));
    const data = await app.reportData('scan', ID);
    expect(data.items).toHaveLength(10);
    expect(data.hidden_count).toBe(1);
    expect(JSON.stringify(data)).not.toContain('private-path-11');
    expect(JSON.stringify(data)).not.toContain('SENSITIVE-SECRET');
    expect(data.items.every(item => item.discovery_origin === 'previous_scan')).toBe(true);
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });

  it('exports the top 20 for a twenty-result allowance and locks the rest behind contact', async () => {
    const app = await setup(row({ show_limit: 20, hits: Array.from({ length: 23 }, (_, index) => finding(index + 1)) }));
    const data = await app.reportData('scan', ID);
    expect(data.items).toHaveLength(20);
    expect(data.hidden_count).toBe(3);
    for (const index of [21, 22, 23]) expect(JSON.stringify(data)).not.toContain(`private-path-${index}"`);
    const preview = await app.assistancePreview(ID);
    expect(preview.results).toHaveLength(20);
    await expect(app.assistancePreview(ID, Array.from({ length: 21 }, (_, index) => index + 1))).rejects.toMatchObject({ status: 400 });
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps provenance out of the explicitly selected assistance preview', async () => {
    const app = await setup();
    expect(await app.assistancePreview(ID, [1])).toEqual({ subject_name: 'Synthetic Subject', subject_type: 'person',
      country: 'Singapore', results: [{ url: 'https://publisher.example/private-path-1', title: 'Private title 1' }] });
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps actual rediscovery dates and ignores malformed historical timestamps', async () => {
    const app = await setup(row({ hits: [finding(1, { reobserved_at: NOW + 1000, last_seen_at: NOW + 1000,
      carried_into_at: Number.MAX_SAFE_INTEGER, previous_observed_at: 'PRIVATE-TEXT' })] }));
    const item = (await app.reportData('scan', ID)).items[0];
    expect(item.reobserved_at).toBe(NOW + 1000);
    expect(item.last_seen_at).toBe(NOW + 1000);
    expect(item).not.toHaveProperty('carried_into_at');
    expect(item).not.toHaveProperty('previous_observed_at');
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });

  it('preserves the original observation after a finding really returns in the current scan', async () => {
    const app = await setup(row({ hits: [finding(1, { discovery_origin: 'search', reobserved_at: NOW + 1000,
      last_seen_at: NOW + 1000 })] }));
    expect((await app.reportData('scan', ID)).items[0]).toMatchObject({ discovery_origin: 'search',
      previous_observed_at: OBSERVED, reobserved_at: NOW + 1000, last_seen_at: NOW + 1000 });
    expect(app.fetchImpl).not.toHaveBeenCalled();
  });
});
