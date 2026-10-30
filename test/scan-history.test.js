import { afterEach, describe, expect, it, vi } from 'vitest';
import { carryForwardFindings } from '../src/scan-history.js';

const NOW = Date.UTC(2026, 8, 30, 12);
const scan = (overrides = {}) => ({ id: 'current-scan', created_at: NOW, full_name: 'Example Person', subject_type: 'person',
  is_minor: false, variants: ['Example Alias'], context: { subject_type: 'person', country_code: 'sg', country: 'Singapore',
    city: 'Sample City', employer: 'Example Employer', school: '', usernames: ['example_handle'] },
  email: 'private@example.com', provider: 'searxng', status: 'done', harm_types: ['scam_fraud'],
  hits: [], queries: [{ id: 1, q: 'Example Person', status: 'done', coverage: { retained: 0 } }], drafts: [], ...overrides });
const hit = (overrides = {}) => ({ id: 3, url: 'https://publisher.example/story', canonical_url: 'publisher.example/story',
  domain: 'publisher.example', title: 'Example Person allegation', snippet: 'Example Person has a complaint.',
  category: 'scam_fraud', severity: 3, match_confidence: 0.8, classified: 1, fetch_state: 'skipped',
  source_query: 'Example Person', status: 'found', created_at: NOW - 2000, ...overrides });
const prior = (overrides = {}) => scan({ id: 'prior-scan', created_at: NOW - 3000, hits: [hit()], ...overrides });
const carry = (current = scan(), history = [prior()]) => carryForwardFindings(current, history, NOW + 5000);

afterEach(() => vi.unstubAllGlobals());

describe('local scan history retention', () => {
  it('retains a historical finding without changing current hits, queries, diagnostics or drafts', () => {
    const currentHit = hit({ id: 20, url: 'https://current.example/result', status: 'sent' });
    const current = scan({ hits: [currentHit], drafts: [{ id: 1, hit_id: 20, body: 'Saved draft' }] });
    const old = prior(), saved = structuredClone(old), result = carry(current, [old]);
    expect(result.changed).toBe(true);
    expect(result.carriedCount).toBe(1);
    expect(result.record.hits[0]).toBe(currentHit);
    expect(result.record.hits[1].id).toBe(21);
    expect(result.record.queries).toBe(current.queries);
    expect(result.record.drafts).toBe(current.drafts);
    expect(result.record.status).toBe('done');
    expect(current.hits).toHaveLength(1);
    expect(old).toEqual(saved);
  });

  it('normalizes case, Unicode and whitespace while ignoring email and search configuration', () => {
    const current = scan({ full_name: '  EXAMPLE   Person ', variants: ['EXAMPLE ALIAS'], email: 'changed@example.com',
      context: { ...scan().context, city: ' Sample   City ', usernames: ['EXAMPLE_HANDLE'] }, provider: 'session', max_queries: 1 });
    expect(carry(current).carriedCount).toBe(1);
    expect(carry(scan({ full_name: 'Ｅxample Person' })).carriedCount).toBe(1);
  });

  it.each([
    { full_name: 'Other Person' }, { subject_type: 'business' }, { is_minor: true }, { variants: ['Other Alias'] },
    ...['country_code', 'country', 'city', 'employer', 'school', 'usernames', 'representative_name', 'website', 'industry']
      .map(field => ({ context: { ...scan().context, [field]: field === 'usernames' ? ['other_handle'] : 'Other context' } })),
  ])('isolates full subject identity and context: %j', difference => {
    expect(carry(scan(difference)).carriedCount).toBe(0);
  });

  it('treats alias and handle ordering as sets without treating punctuation as identity equivalence', () => {
    const aliases = ['Example Alias', 'Example Second'], usernames = ['example_handle', 'example_second'];
    const old = prior({ variants: aliases, context: { ...scan().context, usernames } });
    expect(carry(scan({ variants: aliases.toReversed(), context: { ...scan().context, usernames: usernames.toReversed() } }), [old]).carriedCount).toBe(1);
    expect(carry(scan({ full_name: 'Example-Person' }))).toMatchObject({ changed: false, carriedCount: 0 });
  });

  it('deduplicates validated canonical URLs and preserves current user status', () => {
    const currentHit = hit({ id: 9, url: 'https://www.publisher.example/story/?utm_source=now#top', status: 'not_me' });
    const current = scan({ hits: [currentHit] });
    expect(carry(current)).toEqual({ record: current, carriedCount: 0, changed: false });
    expect(currentHit.status).toBe('not_me');
    const duplicate = hit({ id: 10, url: 'http://m.publisher.example/story?fbclid=old', status: 'found' });
    expect(carry(scan(), [prior({ hits: [hit(), duplicate] })]).record.hits).toHaveLength(1);
  });

  it('recomputes a stored canonical URL rather than trusting it', () => {
    const result = carry(scan(), [prior({ hits: [hit({ canonical_url: 'wrong.example' }), hit({ id: 4, url: 'https://other.example/item', canonical_url: 'wrong.example' })] })]);
    expect(result.record.hits.map(item => item.canonical_url)).toEqual(['publisher.example/story', 'other.example/item']);
  });

  it('keeps the newest prior user status and suppresses older not-me reversals', () => {
    const older = prior({ id: 'older', created_at: NOW - 6000, hits: [hit({ status: 'found', created_at: NOW - 5000 })] });
    const newer = prior({ id: 'newer', created_at: NOW - 3000, hits: [hit({ status: 'removed' })] });
    expect(carry(scan(), [older, newer]).record.hits[0].status).toBe('removed');
    expect(carry(scan(), [older, prior({ hits: [hit({ status: 'not_me' })] })]).carriedCount).toBe(0);
    expect(carry(scan(), [prior({ hits: [hit({ status: 'sent' })] })]).record.hits[0].status).toBe('sent');
  });

  it('records historical provenance without claiming a fresh source observation', () => {
    const item = carry().record.hits[0];
    expect(item).toMatchObject({ discovery_origin: 'previous_scan', previous_scan_id: 'prior-scan', previous_hit_id: 3,
      previous_observed_at: NOW - 2000, last_seen_at: NOW - 2000, carried_into_at: NOW + 5000, created_at: NOW - 2000 });
    expect(item.last_seen_at).not.toBe(item.carried_into_at);
  });

  it('preserves the original observation and provenance through repeated carry-forward', () => {
    const inherited = hit({ discovery_origin: 'previous_scan', previous_scan_id: 'original-scan', previous_hit_id: 81,
      previous_observed_at: NOW - 10000, last_seen_at: NOW - 10000, carried_into_at: NOW - 2500,
      created_at: NOW - 10000, history: [{ status: 'sent', at: NOW - 7000 }], status: 'sent' });
    const item = carry(scan(), [prior({ hits: [inherited] })]).record.hits[0];
    expect(item).toMatchObject({ previous_scan_id: 'original-scan', previous_hit_id: 81, previous_observed_at: NOW - 10000,
      last_seen_at: NOW - 10000, carried_into_at: NOW + 5000, status: 'sent', history: inherited.history });
    expect(item.history).not.toBe(inherited.history);
    const unknown = { ...inherited }; delete unknown.last_seen_at; delete unknown.previous_observed_at; delete unknown.created_at;
    expect(carry(scan(), [prior({ hits: [unknown] })]).carriedCount).toBe(0);
  });

  it('uses original scan creation only as a fallback for missing original observation', () => {
    const item = hit(); delete item.created_at;
    expect(carry(scan(), [prior({ hits: [item] })]).record.hits[0].last_seen_at).toBe(NOW - 3000);
  });

  it.each(['javascript:alert(1)', 'file:///private/path', 'https://user:password@publisher.example/item',
    'http://127.0.0.1/item', 'http://192.168.1.2/item', 'http://10.0.0.1/item', 'http://host.internal/item',
    'https://[::1]/item', 'https://localhost/item', 'not a URL', 'https://publisher.example/\nitem'])('rejects unsafe saved URL %s', url => {
    expect(carry(scan(), [prior({ hits: [hit({ url })] })]).carriedCount).toBe(0);
  });

  it('preserves content-identifying query parameters and fragments on safe saved URLs', () => {
    const url = 'https://publisher.example/story?id=important#item';
    expect(carry(scan(), [prior({ hits: [hit({ url })] })]).record.hits[0].url).toBe(url);
  });

  it('keeps sensitive findings and snippets out of general scan history', () => {
    expect(carry(scan(), [prior({ hits: [hit({ category: 'sensitive_intimate', title: 'Sensitive result — support available', snippet: '' })] })]).carriedCount).toBe(0);
    expect(carry(scan(), [prior({ hits: [hit({ category: 'child_safety' })] })]).carriedCount).toBe(0);
    expect(carry(scan(), [prior({ hits: [hit({ snippet: 'NSFW' })] })]).carriedCount).toBe(0);
    expect(carry(scan(), [prior({ hits: [hit({ url: 'https://publisher.example/%6e%73%66%77' })] })]).carriedCount).toBe(0);
    const older = prior({ id: 'older', created_at: NOW - 6000, hits: [hit({ created_at: NOW - 5000 })] });
    expect(carry(scan(), [older, prior({ hits: [hit({ category: 'sensitive_intimate' })] })]).carriedCount).toBe(0);
    expect(carry(scan({ harm_types: ['sensitive_intimate'] }))).toMatchObject({ changed: false });
    expect(carry(scan(), [prior({ harm_types: ['child_safety'] })]).carriedCount).toBe(0);
  });

  it('requires an earlier scan creation time even when input history is unordered', () => {
    const current = scan();
    const history = [prior({ id: 'future', created_at: NOW + 1 }), prior({ id: current.id, created_at: NOW - 1 }),
      prior({ id: 'same-time', created_at: NOW }), prior()];
    expect(carry(current, history).record.hits[0].previous_scan_id).toBe('prior-scan');
    expect(carry(current, history.slice(0, 3))).toEqual({ record: current, carriedCount: 0, changed: false });
    expect(carry(scan(), [prior({ hits: [hit({ created_at: NOW + 1 })] })]).carriedCount).toBe(0);
  });

  it('bounds history scan candidates and inspected findings', () => {
    const items = Array.from({ length: 1001 }, (_, index) => hit({ id: index + 1, url: `https://publisher.example/${index}` }));
    expect(carry(scan(), [prior({ hits: items })]).carriedCount).toBe(1000);
    const scans = Array.from({ length: 1001 }, (_, index) => prior({ id: `old-${index}`, created_at: NOW - index - 3000,
      hits: [hit({ url: `https://publisher.example/${index}`, created_at: NOW - index - 2000 })] }));
    expect(carry(scan(), scans).carriedCount).toBe(1000);
    expect(carry(scan(), [prior({ hits: Array(1000).fill(null) }), prior({ id: 'older', created_at: NOW - 4000 })]).carriedCount).toBe(0);
  });

  it('is idempotent and never calls network APIs', () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('History must stay local.'); }));
    const first = carry(), second = carry(first.record);
    expect(second).toEqual({ record: first.record, carriedCount: 0, changed: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
