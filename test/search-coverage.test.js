import { describe, it, expect } from 'vitest';
import { searchCoverageView, liveSearchConsentView } from '../public/search-coverage.js';

describe('search coverage explanation',()=>{
  it('names an available SerpApi backup explicitly in both consent and privacy copy', () => {
    const view = liveSearchConsentView({ provider: 'searxng', google_backup_provider: 'serpapi', google_backup_available: true });
    expect(view.backupProvider).toBe('serpapi');
    expect(view.consentCopy).toContain('SearXNG');
    expect(view.consentCopy).toContain('SerpApi for Google web results when SearXNG supplies no usable Google listings');
    expect(view.privacyText).toContain('the same query may also be sent to SerpApi');
    expect(view.privacyText).toContain('Source pages and images are not fetched.'); expect(view.privacyText).toContain('only its hostname is sent'); expect(view.privacyText).not.toContain('hosting-contact lookups are not fetched');
  });
  it.each([
    { provider: 'searxng', google_backup_provider: 'serpapi', google_backup_available: false },
    { provider: 'searxng', google_backup_provider: 'unknown-private-provider', google_backup_available: true },
    { provider: 'serper', google_backup_provider: 'serpapi', google_backup_available: true },
  ])('does not claim consent to an unavailable, unsupported or unrelated backup: %j', config => {
    const view = liveSearchConsentView(config);
    expect(view.backupProvider).toBeNull();
    expect(view.consentCopy).not.toMatch(/SerpApi|unknown-private-provider/);
    expect(view.privacyText).not.toMatch(/SerpApi|unknown-private-provider/);
  });
  it('changes the consent scope when enabling a new backup so existing checkbox approval must be cleared', () => {
    const current = liveSearchConsentView({ provider: 'searxng', google_backup_provider: 'serpapi', google_backup_available: false });
    const enabled = liveSearchConsentView({ provider: 'searxng', google_backup_provider: 'serpapi', google_backup_available: true });
    expect(enabled.scope).not.toBe(current.scope);
    expect(liveSearchConsentView({ provider: 'searxng', google_backup_provider: 'serpapi', google_backup_available: true }).scope).toBe(enabled.scope);
  });
  it('reports Google via SerpApi separately from the primary SearXNG engines and does not guarantee parity', () => {
    const view = searchCoverageView({ provider: 'searxng', configured_search_engines: ['google', 'google cse'],
      search_engines: ['google cse'], configured_google_backup_provider: 'serpapi', google_backup_consent: true,
      google_backup_providers: ['serpapi'], coverage: { diagnostics: { tracked_queries: 1, attempts: 2,
        returned: 2, invalid: 0, limited: 0, no_name: 0, duplicates: 0, retained: 2, complete: true,
        google_backup_attempts: 1, google_backup_recoveries: 1, google_backup_providers: ['serpapi'] } } });
    expect(view.engineText).toBe('Engines with results in this scan: SearXNG · Google CSE. Additional source with results: Google via SerpApi.');
    expect(view.engineNotice).toContain('Google supplied no usable listings in this scan through SearXNG');
    expect(view.countText).toContain('1 backup request for Google via SerpApi was made; 1 supplied usable Google listings');
    expect(view.countText).not.toContain('Google-only attempts');
    expect(view.limitation).toContain('results can differ from your Google.com search');
    expect(view.backupNotice).toContain('authorized for this scan');
    expect(view.cseOnly).toBe(false);
  });
  it('does not claim that an unsuccessful or skipped backup supplied results', () => {
    const view = searchCoverageView({ provider: 'searxng', search_engines: ['google cse'], coverage: {
      diagnostics: { tracked_queries: 2, attempts: 3, returned: 2, invalid: 0, limited: 0, no_name: 0, duplicates: 1,
        google_backup_attempts: 1, google_backup_skips: 1, google_backup_providers: ['serpapi'] } } });
    expect(view.countText).toContain('0 supplied usable Google listings');
    expect(view.countText).toContain('1 SerpApi backup attempts were skipped');
    expect(view.engineText).not.toContain('Additional source');
    expect(view.cseOnly).toBe(true);
  });
  it('explains why a historical scan cannot silently use a newly available backup', () => {
    const view = searchCoverageView({ provider: 'searxng', coverage: {} }, ['google cse'], 'serpapi');
    expect(view.backupNotice).toContain('did not authorize the SerpApi backup');
    expect(view.backupNotice).toContain('Start a new scan');
    expect(view.engineText).not.toContain('Google via SerpApi');
    expect(view.countText).toContain('predates request diagnostics');
  });
  it('never reflects unsupported provider labels or treats them as a recorded Google backup source', () => {
    const view = searchCoverageView({ provider: 'searxng', google_backup_providers: ['secret-token'],
      configured_google_backup_provider: 'secret-token', coverage: { diagnostics: { tracked_queries: 1,
        google_backup_providers: ['secret-token'], google_backup_attempts: 1, google_backup_recoveries: 1 } } }, [], 'secret-token');
    expect(JSON.stringify(view)).not.toContain('secret-token');
    expect(view.engineText).not.toContain('Google via SerpApi');
    expect(view.countText).not.toContain('SerpApi');
    expect(view.backupNotice).toBe('');
  });
  it('explains actual Google retry counts without claiming complete coverage',()=>{
    const view=searchCoverageView({provider:'searxng',coverage:{diagnostics:{tracked_queries:1,attempts:2,returned:2,
      no_name:0,duplicates:0,invalid:0,limited:0,retained:2,google_retries:1,google_recoveries:1,complete:true}}});
    expect(view.countText).toContain('1 additional Google-only attempts');
    expect(view.countText).toContain('1 supplied usable Google listings');
    expect(view.limitation).toContain('does not establish');
  });
  it('identifies the current CSE connection without claiming a historical scan used it',()=>{
    const view = searchCoverageView({provider:'searxng',coverage:{retained:23,professional:7,sensitive:0},moreCount:6},['google cse']);
    expect(view.engineText).toBe('Configured engines: SearXNG · Google CSE.');
    expect(view.limitation).toContain('subset');
    expect(view.countText).toContain('cannot tell');
    expect(view.exclusions).toContain('7 professional matches and 0 sensitive matches');
  });
  it('reports measured provider/filter counts and does not expose result URLs or queries',()=>{
    const view = searchCoverageView({provider:'searxng',search_engines:['google','bing'],coverage:{retained:5,
      diagnostics:{complete:true,tracked_queries:1,returned:22,attempts:1,no_name:10,duplicates:5,invalid:2,limited:0}},moreCount:0});
    expect(view.engineText).toBe('Engines with results in this scan: SearXNG · Google, Bing.');
    expect(view.cseOnly).toBe(false);
    expect(view.countText).toContain('22 provider listings');
    expect(view.countText).toContain('10 did not match');
    expect(view.countText).not.toContain('predates');
  });
  it('uses recorded engines over a changed connection and rejects arbitrary engine values',()=>{
    const view = searchCoverageView({provider:'searxng',search_engines:['google cse','secret'],coverage:{}},['bing']);
    expect(view.cseOnly).toBe(true);
    expect(view.engineText).not.toContain('secret');
    expect(view.engineText).not.toContain('Bing');
  });
  it('warns when a selected engine supplied no usable listings without claiming a failure cause',()=>{
    const view = searchCoverageView({provider:'searxng', configured_search_engines:['google','bing','google cse'],
      search_engines:['bing','google cse'],coverage:{diagnostics:{tracked_queries:24,complete:true}}});
    expect(view.engineNotice).toContain('Google supplied no usable listings');
    expect(view.engineNotice).toContain('does not establish coverage');
    expect(view.engineNotice).not.toMatch(/blocked|failed|removed|currently configured/);
  });
  it('does not claim a historical engine selection from current configuration',()=>{
    expect(searchCoverageView({provider:'searxng',search_engines:['google cse'],coverage:{}},['google','bing']).engineNotice).toBe('');
    const view = searchCoverageView({provider:'searxng',search_engines:['bing','google cse'],coverage:{diagnostics:{tracked_queries:1}}},['google','bing','google cse']);
    expect(view.engineNotice).toContain('original selection was not recorded');
  });
  it('keeps previous findings separate from measured search counts',()=>{
    const view = searchCoverageView({provider:'searxng',coverage:{retained:8,carried:3,
      diagnostics:{tracked_queries:1,returned:5,attempts:1,no_name:0,duplicates:0,invalid:0,limited:0,retained:5,complete:true}}});
    expect(view.countText).toContain('5 new name matches');
    expect(view.countText).not.toContain('8 new');
    expect(view.historyText).toContain('3 earlier findings');
    expect(view.historyText).toContain('does not confirm removal');
  });
});
