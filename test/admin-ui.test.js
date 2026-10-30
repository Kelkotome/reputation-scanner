import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = Date.UTC(2026, 8, 30, 12);
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(' '); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  addEventListener() {}
  setAttribute(name, value) { this.attributes[name] = value; }
  focus() {}
}
const totals = () => ({ scan_starts: 1, search_attempts: 2, search_successes: 1, search_failures: 1,
  estimated_search_cost_usd: 0, in_tokens: 0, out_tokens: 0, tokens: 0, ai_cost_usd: 0 });
const backup = (extra = {}) => ({ provider: 'serpapi', cost_per_1000_queries: 0, estimated: true, role: 'backup',
  daily_query_limit: 50, estimate_supplied: false,
  estimate_notice: 'No cost estimate supplied. A zero estimate does not establish that the backup provider is free.', ...extra });
const usage = providers => ({ today: { date: '2026-09-30', public: totals(), operator: totals() },
  days: [{ date: '2026-09-30', public: totals(), operator: totals() }], providers,
  cloud_ai_enabled: false, public_daily_limit: 3, retention_days: 30 });

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

async function render(providers) {
  const nodes = new Map();
  const document = { createElement: tag => new Element(tag), querySelector: selector => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  }, querySelectorAll: () => [] };
  const fetchImpl = vi.fn(async path => {
    if (path === '/api/operator/session') return Response.json({ operator: true, expires_at: NOW + 3_600_000 });
    if (path === '/api/operator/usage') return Response.json(usage(providers));
    throw new Error('Unexpected network route in synthetic admin UI test.');
  });
  vi.stubGlobal('document', document); vi.stubGlobal('window', { addEventListener() {} }); vi.stubGlobal('fetch', fetchImpl);
  await import('../public/admin.js');
  await vi.waitFor(() => expect(nodes.get('#admin-status').textContent).toBe('Operator session active. Usage is visible only after server authentication.'));
  return { list: nodes.get('#admin-provider-rates'), nodes, fetchImpl };
}

describe('operator dashboard backup estimates', () => {
  it('shows the selected backup and shared daily cap while labeling its unknown cost', async () => {
    const { list, fetchImpl } = await render([{ provider: 'searxng', cost_per_1000_queries: 0, estimated: true }, backup()]);
    const primary = list.children[0].textContent, provider = list.children[1].textContent;
    expect(primary).toContain('SearXNG');
    expect(provider).toContain('SerpApi backup');
    expect(provider).toContain('Estimate not supplied');
    expect(provider).toContain('Daily backup cap: 50 attempted requests across public and operator use (UTC).');
    expect(provider).toContain('A zero estimate does not establish that the backup provider is free.');
    expect(provider).not.toContain('$0');
    expect(fetchImpl.mock.calls.map(([path]) => path)).toEqual(['/api/operator/session', '/api/operator/usage', '/api/operator/partners']);
  });

  it('renders a supplied backup estimate with its configured-billing caveat', async () => {
    const { list } = await render([backup({ cost_per_1000_queries: 6.5, estimate_supplied: true,
      estimate_notice: 'Configured estimate; actual provider billing may differ.', daily_query_limit: 12 })]);
    expect(list.textContent).toContain('SerpApi backup');
    expect(list.textContent).toContain('$6.5000 / 1,000');
    expect(list.textContent).toContain('Daily backup cap: 12 attempted requests');
    expect(list.textContent).toContain('Configured estimate; actual provider billing may differ.');
    expect(list.textContent).not.toContain('Estimate not supplied');
  });

  it('supplies an unknown-cost caveat for a legacy backup DTO without claiming zero-cost service', async () => {
    const { list } = await render([{ provider: 'serpapi', role: 'backup', cost_per_1000_queries: 0, daily_query_limit: 0 }]);
    expect(list.textContent).toContain('Estimate not supplied');
    expect(list.textContent).toContain('Check the provider’s billing before relying on these totals.');
    expect(list.textContent).toContain('Daily backup cap: 0 attempted requests');
    expect(list.textContent).not.toContain('$0');
  });

  it('renders provider caveats as text without creating HTML from server strings', async () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const { list } = await render([backup({ estimate_notice: malicious })]);
    expect(list.textContent).toContain(malicious);
    const tags = node => [node.tagName, ...node.children.flatMap(tags)];
    expect(tags(list)).not.toContain('img');
    expect(tags(list)).not.toContain('script');
  });
});
