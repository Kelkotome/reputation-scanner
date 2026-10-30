// Browser-owned scans. Only explicit search queries cross the injected relay;
// source pages, signing details, emails, drafts and record IDs stay local.
import { COUNTRIES, COUNTRY_ALIASES } from './countries.js';
import { norm, nameForms } from './text.js';
import { buildSeedQueries, mergeQueries, queriesFromSuggestions, queryKey } from './queries.js';
import { prefilter, rankHits, isProfessionalListing, resultMentionsName } from './rank.js';
import { carryForwardFindings } from './scan-history.js';
import { classifyHeuristic } from './classify.js';
import { mockSearch, mockAutocomplete, EXTERNAL } from './serp.js';
import { CATEGORY_LABELS, CATEGORY_SIGNALS } from './lexicon.js';
import { platformFor, googleChannelFor } from './platforms.js';
import { templatesFor, TEMPLATES } from './templates.js';
import { urlValue } from './takedowns.js';
import { SEARCH_RESULT_LIMIT, VISIBLE_RESULT_LIMIT, safeSearchEngines } from './search-limits.js';
import { aiDraftPayload, localAiDraft, AI_FACTS_LIMIT } from './browser-ai-draft.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES = new Set(['not_me', 'resolved', 'sent', 'removed', 'refused', 'escalated']);
const HARMS = new Set([...Object.keys(CATEGORY_LABELS).filter(x => !['neutral', 'same_name_other_person'].includes(x)), 'child_safety']);
const COUNTRY_CODES = new Map(COUNTRIES.map(c => [c.code, c.name]));
const COUNTRY_NAMES = new Map([...COUNTRIES.map(c => [norm(c.name), c.code]), ...Object.entries(COUNTRY_ALIASES).map(([name, code]) => [norm(name), code])]);
const SENSITIVE = /\b(?:nudes?|nudity|naked|porn(?:ography|ographic)?|sex(?:ual)?[\s-]*(?:tapes?|videos?|images?|abuse)|intimate[\s-]+(?:images?|content|videos?)|revenge[\s-]+porn|child[\s-]+(?:sexual|abuse)|onlyfans|fansly|nsfw|xxx|xvideos?|xnxx|xhamster|hentai)\b|裸照|色情/i;
const FINISHED = new Set(['done', 'error', 'paused_budget', 'help_only', 'awaiting_import']);
const sensitive = value => {
  let decoded = String(value || '');
  try { decoded = decodeURIComponent(decoded); } catch { /* Check raw text. */ }
  return SENSITIVE.test(decoded.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[+_/-]+/g, ' '));
};
const safeQuery = q => typeof q === 'string' && q.trim() && q.length <= 500 && !sensitive(q);
const bounded = (value, fallback, max) => Number.isFinite(Number(value)) && Number(value) >= 1 ? Math.min(max, Math.floor(Number(value))) : fallback;
const formsFor = scan => nameForms(scan.full_name, scan.variants, scan.context.usernames, scan.subject_type);
const searchCountrySupported = scan => scan.provider !== 'searxng' && scan.search_country_supported !== false;
const autocompleteSupported = scan => !['session', 'brave', 'searxng'].includes(scan.provider) && scan.autocomplete_supported !== false;
const configuredGoogleBackup = cfg => cfg?.provider === 'searxng' && cfg.google_backup_available === true
  && cfg.google_backup_provider === 'serpapi' ? 'serpapi' : null;
const safeBackupProviders = values => Array.isArray(values) && values.includes('serpapi') ? ['serpapi'] : [];
const nextUtcReset = timestamp => (Math.floor(timestamp / 86_400_000) + 1) * 86_400_000;
const QUOTA_MESSAGES = {
  scan_limit_reached: 'This network has used its public scan allowance for today. It resets at 00:00 UTC. Your local progress is saved.',
  search_ticket_exhausted: 'This scan has used its search request allowance. Saved results remain available. Retry after 00:00 UTC to use a new daily scan slot.',
  search_ticket_expired: 'This scan’s search permit has expired. Retry to continue using the current daily allowance.',
  search_ticket_invalid: 'This scan’s search permit is no longer valid for this session or network. Retry to request a new permit.',
  search_ticket_required: 'Your search access has changed. Retry to check access before continuing.',
  operator_sign_in_required: 'Sign in as an operator to continue this larger scan. Your saved results are still available in this browser.',
  bot_check_required: 'Complete the security check before starting this search. Retry to continue.',
  bot_check_failed: 'The security check was not accepted. Retry with a fresh check.',
  bot_check_expired: 'The security check expired. Retry with a fresh check.',
  bot_check_cancelled: 'The security check was cancelled. Your local progress is saved; retry when you are ready.',
  bot_check_unavailable: 'The security check is unavailable. Your local progress is saved; please try again later.',
  scan_cooldown: 'Please wait before starting another scan. Your local progress is saved.',
  search_busy: 'The search service is busy. Your local progress is saved; retry shortly.',
  request_rate_limited: 'Too many requests were made in a short time. Your local progress is saved; retry shortly.',
};

function fail(status, message, code) { const error = new Error(message); error.status = status; if (code) error.code = code; throw error; }
function text(value, max, label, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, `Invalid ${label}.`);
  return value.trim();
}
function bodyValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Invalid JSON body.');
  return value;
}
function list(value, max, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail(400, `Invalid ${label}.`);
  return value.map(item => text(item, 80, label, true));
}
function countryContext(c) {
  let code = '';
  if (Object.hasOwn(c, 'country_code')) {
    if (typeof c.country_code !== 'string') fail(400, 'Choose a country or region from the list, or leave it blank.');
    code = c.country_code.trim().toLowerCase();
    if (code === 'gb') code = 'uk';
  } else {
    const name = text(c.country, 120, 'country');
    if (name) code = COUNTRY_NAMES.get(norm(name));
  }
  if (code !== '' && !COUNTRY_CODES.has(code)) fail(400, 'Choose a country or region from the list, or leave it blank.');
  return { country_code: code, country: code ? COUNTRY_CODES.get(code) : '' };
}
function websiteValue(value) {
  const raw = text(value, 2048, 'business website');
  if (!raw) return '';
  const url = new URL(urlValue(raw, fail)), host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (/\.(?:test|invalid)$/.test(host)) fail(400, 'Enter a public business website URL without login details.');
  url.hostname = host;
  return url.origin;
}
function createInput(value) {
  const b = bodyValue(value), subject_type = b.subject_type === undefined ? 'person' : b.subject_type;
  if (!['person', 'business'].includes(subject_type)) fail(400, 'Choose an individual or business scan.');
  const business = subject_type === 'business', full_name = text(b.full_name, 80, business ? 'business name' : 'name', true);
  if (full_name.length < 2) fail(400, 'Name must be between 2 and 80 characters.');
  if (b.attestation !== true) fail(400, business ? 'Confirm that you own or are authorised to represent this business.' : 'Confirm that you are searching for yourself or your child.');
  if (typeof b.is_minor !== 'boolean') fail(400, 'Choose whether the person is under 18.');
  if (business && b.is_minor) fail(400, 'Use the individual scan for a person under 18.');
  const harm_types = list(b.harm_types, 8, 'harm types');
  if (harm_types.some(type => !HARMS.has(type))) fail(400, 'Invalid harm type.');
  if (harm_types.some(type => ['sensitive_intimate', 'child_safety'].includes(type)) || sensitive(full_name)) return { help_only: true };
  const variants = list(b.variants, 5, 'aliases'), c = b.context ?? {};
  if (!c || typeof c !== 'object' || Array.isArray(c)) fail(400, 'Invalid context.');
  const context = { subject_type, ...countryContext(c), ...Object.fromEntries((business ? ['city', 'industry'] : ['city', 'employer', 'school']).map(key => [key, text(c[key], 120, key)])) };
  if (business) {
    context.representative_name = text(c.representative_name, 80, 'representative name', true);
    if (context.representative_name.length < 2 || /[\r\n]/.test(context.representative_name)) fail(400, 'Enter the representative’s name (2–80 characters).');
    context.website = websiteValue(c.website);
  }
  context.usernames = list(c.usernames, 5, 'usernames');
  const email = text(b.email, 254, 'email');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid email address.');
  return { full_name, subject_type, variants, context, email, is_minor: b.is_minor, harm_types,
    attestation: true, live_search_consent: b.live_search_consent === true,
    google_backup_consent: b.google_backup_consent === true, utm: text(b.utm, 300, 'source') };
}

function appendQueries(scan, incoming) {
  const existing = new Set(scan.queries.map(q => queryKey(q.q, q.page)));
  const fresh = mergeQueries([incoming.filter(q => safeQuery(q.q))], 60)
    .filter(q => !existing.has(queryKey(q.q, q.page)))
    .slice(0, Math.max(0, scan.max_queries - scan.queries.length));
  let next = Math.max(0, ...scan.queries.map(q => q.id)) + 1;
  return { ...scan, queries: [...scan.queries, ...fresh.map(q => ({ ...q, id: next++, status: 'pending', results: 0 }))] };
}
const coverageNumber = (value, fallback = 0) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : fallback;
const AUDIT_COUNTS = ['returned', 'invalid', 'limited', 'no_name', 'duplicates', 'retained', 'attempts'];
function mergeCoverage(previous, incoming) {
  const counts = Object.fromEntries(AUDIT_COUNTS.map(key => [key, coverageNumber(previous?.[key]) + coverageNumber(incoming?.[key])]));
  for (const key of ['google_retries', 'google_recoveries', 'google_recovery_skips',
    'google_backup_attempts', 'google_backup_recoveries', 'google_backup_skips']) {
    const count = coverageNumber(previous?.[key]) + coverageNumber(incoming?.[key]);
    if (count) counts[key] = count;
  }
  const providers = safeBackupProviders([...(Array.isArray(previous?.google_backup_providers) ? previous.google_backup_providers : []),
    ...(Array.isArray(incoming?.google_backup_providers) ? incoming.google_backup_providers : [])]);
  if (providers.length) counts.google_backup_providers = providers;
  return counts;
}
function hitClassification(scan, hit, guarded) {
  return guarded ? { category: 'sensitive_intimate', severity: 5, match_confidence: 0,
    reason: 'Use the support resources; this result was not opened.' } : classifyHeuristic(scan, hit);
}
function enrichDuplicate(scan, current, observed, source, timestamp, forms) {
  // Once a source needs specialist routing, later thin snippets cannot expose it.
  if (current.category === 'sensitive_intimate') return current;
  const guarded = sensitive(`${observed.url} ${observed.title} ${observed.snippet}`);
  if (!guarded && !resultMentionsName(observed, forms)) return current;
  const observation = { last_seen_at: timestamp,
    ...(current.discovery_origin === 'previous_scan' ? { discovery_origin: 'search', reobserved_at: timestamp } : {}) };
  const incoming = hitClassification(scan, observed, guarded);
  const stronger = incoming.category !== 'neutral' && (current.category === 'neutral'
    || incoming.severity > (current.severity || 0)
    || (incoming.severity === current.severity && incoming.match_confidence > (current.match_confidence || 0)));
  const confidence = Math.max(current.match_confidence ?? 0.5, incoming.match_confidence);
  const updated = guarded ? { ...current, ...observation, ...incoming, title: 'Sensitive result — support available', snippet: '', context_text: '' }
    : { ...current, ...observation, ...(stronger ? incoming : {}), match_confidence: confidence,
      title: (stronger ? observed.title : current.title) || observed.title || current.title,
      snippet: (stronger ? observed.snippet : current.snippet) || observed.snippet || current.snippet };
  if (['title', 'snippet', 'category', 'severity', 'match_confidence', 'reason'].every(key => updated[key] === current[key])) return { ...current, ...observation };
  // Keep first discovery and tracking fields intact. This bounded local ledger
  // records which query supplied a substantive metadata update, not page text.
  return { ...updated, metadata_updates: [...(Array.isArray(current.metadata_updates) ? current.metadata_updates : []),
    { source_query: source, at: timestamp }].slice(-60) };
}
function appendHits(scan, incoming, source, timestamp, providerCoverage) {
  const items = Array.isArray(incoming) ? incoming : [];
  const valid = [];
  let invalid = 0;
  for (const item of items.slice(0, SEARCH_RESULT_LIMIT)) {
    try {
      valid.push({ url: urlValue(item?.url, fail), title: typeof item.title === 'string' ? item.title.slice(0, 500) : '',
        snippet: typeof item.snippet === 'string' ? item.snippet.slice(0, 2000) : '', kind: item.kind === 'autocomplete' ? 'autocomplete' : 'web' });
    } catch { invalid++; /* Invalid provider URLs are never stored or opened. */ }
  }
  const seen = new Set(scan.hits.map(h => h.canonical_url)), domainCounts = new Map();
  for (const hit of scan.hits) domainCounts.set(hit.domain, (domainCounts.get(hit.domain) || 0) + 1);
  // Distinct pages on the same platform remain separate removal targets.
  const forms = formsFor(scan);
  const { kept, duplicates, droppedNoName, droppedDup } = prefilter(valid, forms, { seen, domainCounts, domainCap: Infinity });
  let next = Math.max(0, ...scan.hits.map(hit => hit.id)) + 1;
  const hits = kept.map(hit => {
    const guarded = sensitive(`${hit.url} ${hit.title} ${hit.snippet}`);
    const classification = hitClassification(scan, hit, guarded);
    return { ...hit, id: next++, title: guarded ? 'Sensitive result — support available' : hit.title,
      snippet: guarded ? '' : hit.snippet, source_query: source, ...classification,
      classified: 1, fetch_state: 'skipped', status: 'found', created_at: timestamp, last_seen_at: timestamp, discovery_origin: 'search' };
  });
  const retained = [...scan.hits, ...hits], indices = new Map(retained.map((hit, index) => [hit.canonical_url, index]));
  for (const observed of duplicates) {
    const index = indices.get(observed.canonical_url);
    if (index !== undefined) retained[index] = enrichDuplicate(scan, retained[index], observed, source, timestamp, forms);
  }
  const coverage = { returned: coverageNumber(providerCoverage?.returned, items.length),
    invalid: coverageNumber(providerCoverage?.invalid) + invalid,
    limited: coverageNumber(providerCoverage?.limited) + Math.max(0, items.length - SEARCH_RESULT_LIMIT),
    no_name: droppedNoName, duplicates: droppedDup, retained: hits.length, attempts: coverageNumber(providerCoverage?.attempts, 1) };
  const recoveryAttempt = ['recovered', 'empty', 'failed'].includes(providerCoverage?.google_recovery);
  const recoverySkip = ['budget_skipped', 'time_skipped'].includes(providerCoverage?.google_recovery);
  const backup = providerCoverage?.google_backup_provider === 'serpapi';
  const backupRecovered = backup && providerCoverage.google_recovery === 'recovered' && providerCoverage.attempts === 2;
  if (backup && ((recoveryAttempt && providerCoverage.attempts === 2) || (recoverySkip && providerCoverage.attempts === 1))) {
    coverage.google_backup_providers = ['serpapi'];
    if (recoveryAttempt) coverage.google_backup_attempts = 1;
    if (backupRecovered) coverage.google_backup_recoveries = 1;
    if (recoverySkip) coverage.google_backup_skips = 1;
  } else if (providerCoverage?.google_backup_provider === undefined) {
    if (recoveryAttempt) {
      coverage.google_retries = 1;
      if (providerCoverage.google_recovery === 'recovered') coverage.google_recoveries = 1;
    } else if (recoverySkip) coverage.google_recovery_skips = 1;
  }
  // The merged response's Google attribution can come from the API backup.
  // Keep that source separate from the engines used by SearXNG itself.
  const primaryEngines = safeSearchEngines(providerCoverage?.engines).filter(engine => !backupRecovered || engine !== 'google');
  return { record: { ...scan, hits: retained,
    search_engines: [...new Set([...safeSearchEngines(scan.search_engines), ...primaryEngines])],
    ...(backupRecovered ? { google_backup_providers: ['serpapi'] } : {}) },
    inserted: hits.length, coverage };
}
function publicHit(scan, hit) {
  const { context_text, source_query, canonical_url, scan_id, metadata_updates, ...rest } = hit;
  return { ...rest, category_label: scan.subject_type === 'business' && hit.category === 'same_name_other_person'
    ? 'Different business with the same name' : CATEGORY_LABELS[hit.category] || 'Review needed' };
}
function reviewableHits(scan) {
  return scan.hits.filter(hit => hit.category !== 'sensitive_intimate'
    && (scan.subject_type === 'business' || !isProfessionalListing(hit)));
}
export function report(scan) {
  const safe = reviewableHits(scan);
  const ranked = rankHits(safe, scan.show_limit, { includeNeutral: true }), all = rankHits(safe, safe.length, { includeNeutral: true }).shown;
  const tracked = scan.queries.filter(query => query.coverage);
  const measured = scan.queries.filter(query => query.status === 'done' || query.coverage);
  const diagnostics = { complete: measured.every(query => query.coverage), tracked_queries: tracked.length,
    ...tracked.reduce((total, query) => mergeCoverage(total, query.coverage), {}) };
  return { id: scan.id, status: scan.status, error: scan.error, error_code: scan.error_code || null, full_name: scan.full_name, subject_type: scan.subject_type,
    country: scan.context.country, provider: scan.provider, is_minor: scan.is_minor,
    partial: scan.partial === true, search_country_supported: searchCountrySupported(scan), autocomplete_supported: autocompleteSupported(scan),
    search_engines: safeSearchEngines(scan.search_engines), configured_search_engines: safeSearchEngines(scan.configured_search_engines),
    configured_google_backup_provider: scan.configured_google_backup_provider === 'serpapi' ? 'serpapi' : null,
    google_backup_consent: scan.google_backup_consent === true,
    google_backup_providers: safeBackupProviders(scan.google_backup_providers),
    progress: { total: scan.queries.length, completed: scan.queries.filter(q => q.status !== 'pending').length, classified: scan.hits.filter(h => h.classified).length, hits: scan.hits.length },
    shown: ranked.shown.map(hit => publicHit(scan, hit)), extra: all.slice(ranked.shown.length).map(hit => publicHit(scan, hit)),
    moreCount: ranked.moreCount, sameNameCount: ranked.sameNameCount,
    sameName: safe.filter(h => h.classified && (h.category === 'same_name_other_person' || h.match_confidence < 0.3)).slice(0, 10).map(hit => publicHit(scan, hit)),
    notMe: safe.filter(hit => hit.status === 'not_me').map(hit => publicHit(scan, hit)),
    helpRequired: scan.hits.some(hit => hit.category === 'sensitive_intimate'),
    coverage: { retained: scan.hits.length, reviewable: all.length,
      carried: all.filter(hit => hit.discovery_origin === 'previous_scan').length,
      flagged: all.filter(hit => hit.category !== 'neutral').length, ordinary: all.filter(hit => hit.category === 'neutral').length,
      professional: scan.subject_type === 'business' ? 0 : scan.hits.filter(isProfessionalListing).length,
      sensitive: scan.hits.filter(hit => hit.category === 'sensitive_intimate').length, diagnostics },
    usage: { serp_queries: scan.serp_queries, in_tokens: 0, out_tokens: 0, cost_usd: null },
    allowance: { operator: scan.operator_access === true, remaining_scans: scan.search_permit?.remaining_scans ?? null,
      reset_at: scan.quota_reset_at || scan.search_permit?.reset_at || null },
    ...(scan.status === 'awaiting_import' ? { queries: scan.queries.filter(q => q.status === 'pending') } : {}) };
}
function draftInfo(scan, hit, body, timestamp) {
  const senderEmail = body.sender_email === undefined ? scan.email : text(body.sender_email, 254, 'contact email');
  if (senderEmail && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(senderEmail)) fail(400, 'Enter a valid contact email.');
  if (body.owns_content !== undefined && typeof body.owns_content !== 'boolean') fail(400, 'Invalid content ownership choice.');
  if (hit.category === 'sensitive_intimate') return { help_only: true, channel: null, google: null, abuse: null, templates: [], draft: null };
  const eligible = templatesFor(hit, { isMinor: scan.is_minor, ownsContent: body.owns_content === true, subjectType: scan.subject_type });
  if (body.template && !eligible.includes(body.template)) fail(400, 'That request template is not available for this result.');
  const channel = hit.kind === 'autocomplete'
    ? { name: 'Google search suggestions', form: 'https://support.google.com/websearch/answer/106230', how: 'Use Report inappropriate predictions below the search box. A suggestion does not establish that an allegation is true.' }
    : platformFor(hit.url, { template: body.template });
  const result = { channel, google: googleChannelFor(hit.category), abuse: null,
    templates: eligible.map(id => ({ id, label: TEMPLATES[id].label })), draft: null };
  const saved = [...scan.drafts].reverse().find(draft => draft.hit_id === hit.id
    && draft.owns_content === (body.owns_content === true) && eligible.includes(draft.template)
    && (!body.template || draft.template === body.template)
    && (body.sender_email === undefined || (draft.sender_email ?? scan.email) === senderEmail));
  result.sender_email = saved?.sender_email ?? senderEmail ?? '';
  result.saved_draft = saved || null;
  if (saved && hit.kind !== 'autocomplete') result.channel = platformFor(hit.url, { template: saved.template });
  if (body.template) {
    if (saved) return { ...result, draft: saved };
    const context = { full_name: scan.full_name, email: senderEmail, url: hit.url, subject_type: scan.subject_type,
      representative_name: scan.context.representative_name, owns_content: body.owns_content === true };
    const template = TEMPLATES[body.template];
    result.draft = { id: Math.max(0, ...scan.drafts.map(draft => draft.id)) + 1, hit_id: hit.id, subject: template.subject(context),
      body: template.body(context), template: body.template, owns_content: body.owns_content === true, sender_email: senderEmail || '',
      channel: channel || {}, source: 'template', created_at: timestamp };
  }
  return result;
}

export function createBrowserScans({ store, config, relay, permit, aiDraft, now = Date.now, uuid = () => crypto.randomUUID() }) {
  for (const method of ['get', 'put', 'remove', 'update', 'list']) if (typeof store?.[method] !== 'function') throw new TypeError(`Scan store requires ${method}().`);
  const get = async id => {
    if (!UUID.test(id || '')) fail(404, 'Scan not found.');
    const scan = await store.get('scan', id);
    if (!scan) fail(404, 'Scan not found.');
    return scan;
  };
  const update = async (id, mutator) => {
    if (!UUID.test(id || '')) fail(404, 'Scan not found.');
    const result = await store.update('scan', id, scan => { if (!scan) fail(404, 'Scan not found.'); return mutator(scan); });
    if (!result) fail(404, 'Scan not found.');
    return result;
  };
  const step = async id => {
    const token = uuid(); let acquired = false;
    let scan = await update(id, current => {
      if (FINISHED.has(current.status) || current.lease_until > now()) return current;
      acquired = true;
      return { ...current, lease_token: token, lease_until: now() + 90_000 };
    });
    if (!acquired) return scan;
    let requests = 0, failure = null, seeds = [], outcomes = [], cfg = null, permitPromise;
    const planning = scan.status === 'planning';
    try {
      // An unsupported country remains local identity context, not a search term.
      if (planning) seeds = buildSeedQueries(searchCountrySupported(scan) ? scan
        : { ...scan, context: { ...scan.context, country: '', country_code: '' } });
      if (planning && scan.provider === 'searxng') {
        // Spend two existing request slots on page 2 of the broad name searches.
        // Every page gets its own quota reservation and progress entry.
        seeds = [...seeds.slice(0, 2), ...seeds.slice(0, 2).map(query => ({ ...query, page: 2, source: 'name_page' })), ...seeds.slice(2)];
      }
      if (EXTERNAL.has(scan.provider)) {
        cfg = await config();
        if (!scan.live_search_consent || cfg.search_relay_enabled !== true || cfg.provider !== scan.provider) fail(503, 'Live search is unavailable.');
        if (cfg.operator === false && scan.max_queries > bounded(cfg.max_queries, 12, 60)) {
          fail(403, QUOTA_MESSAGES.operator_sign_in_required, 'operator_sign_in_required');
        }
      }
      const ensurePermit = () => {
        if (cfg?.scan_ticket_required !== true) return Promise.resolve(null);
        if (!permitPromise) permitPromise = (async () => {
          if (typeof permit !== 'function') fail(503, 'Search permits are unavailable.');
          let owned = false, retrying = false;
          scan = await update(id, current => {
            if (current.lease_token !== token) return current;
            owned = true;
            const held = current.search_permit, operator = cfg.operator === true;
            const currentMode = held?.operator === operator;
            if (currentMode && typeof held.ticket === 'string' && held.ticket && held.expires_at > now()) return current;
            const reusableNonce = currentMode && !held.ticket && held.request_reset_at > now()
              && UUID.test(held.request_id || '') && held.request_id !== id;
            retrying = Boolean(reusableNonce);
            return { ...current, search_permit: { request_id: reusableNonce ? held.request_id : uuid(),
              request_reset_at: nextUtcReset(now()), operator } };
          });
          if (!owned) fail(409, 'Another tab is continuing this scan.');
          const held = scan.search_permit;
          if (held.ticket && held.expires_at > now()) return held.ticket;
          // This random id is solely an idempotency nonce; never send the local scan id.
          const checkLease = async () => {
            let currentOwner = false;
            await update(id, current => {
              if (current.lease_token !== token) return current;
              currentOwner = true;
              return { ...current, lease_until: now() + 90_000 };
            });
            if (!currentOwner) fail(409, 'Another tab is continuing this scan.');
          };
          // A person may need time to complete the challenge. Keep one tab in
          // charge, and check deletion/ownership again before minting a permit.
          let leaseFailure;
          const heartbeat = setInterval(() => { checkLease().catch(error => { leaseFailure = error; }); }, 30_000);
          let issued;
          try {
            issued = await permit({ request_id: held.request_id }, { settings: cfg, retrying,
              beforeSend: async () => { if (leaseFailure) throw leaseFailure; await checkLease(); } });
          } finally { clearInterval(heartbeat); }
          if (typeof issued?.search_ticket !== 'string' || !issued.search_ticket || issued.search_ticket.length > 8192
            || !Number.isFinite(issued.expires_at) || issued.expires_at <= now()
            || !Number.isFinite(issued.reset_at) || !Number.isSafeInteger(issued.max_requests) || issued.max_requests < 1
            || !(issued.remaining_scans === null || (Number.isSafeInteger(issued.remaining_scans) && issued.remaining_scans >= 0))) {
            fail(502, 'The service returned an invalid search permit.');
          }
          let committed = false;
          scan = await update(id, current => {
            if (current.lease_token !== token || current.search_permit?.request_id !== held.request_id) return current;
            committed = true;
            return { ...current, search_permit: { ...current.search_permit, ticket: issued.search_ticket,
              expires_at: issued.expires_at, reset_at: issued.reset_at, remaining_scans: issued.remaining_scans, max_requests: issued.max_requests } };
          });
          if (!committed) fail(409, 'Another tab is continuing this scan.');
          return issued.search_ticket;
        })();
        return permitPromise;
      };
      const request = async (q, kind, page = 1) => {
        if (!safeQuery(q)) return { results: [], suggestions: [], related: [] };
        if (scan.provider === 'mock') {
          return kind === 'autocomplete' ? { suggestions: mockAutocomplete(q) } : mockSearch(q, scan.subject_type);
        }
        if (scan.provider === 'session') return { results: [], suggestions: [], related: [] };
        const ticket = await ensurePermit();
        requests++;
        return relay({ q, country_code: searchCountrySupported(scan) ? scan.context.country_code : '', kind,
          ...(page > 1 ? { page } : {}),
          ...(kind === 'search' && scan.google_backup_consent === true && scan.live_search_consent === true
            && configuredGoogleBackup(cfg) === scan.configured_google_backup_provider && scan.configured_google_backup_provider === 'serpapi'
            ? { google_backup_consent: true } : {}),
          ...(ticket ? { search_ticket: ticket } : {}) });
      };
      if (planning) {
        const prefixes = autocompleteSupported(scan) ? [`${scan.full_name} `, `${scan.full_name} s`].filter(safeQuery) : [];
        const results = await Promise.allSettled(prefixes.map(q => request(q, 'autocomplete')));
        outcomes = results.filter(result => result.status === 'fulfilled').map(result => ({ suggestions: result.value?.suggestions || [] }));
        failure = results.find(result => result.status === 'rejected')?.reason || null;
      } else {
        const batchSize = cfg?.abuse_protection_enabled === true && cfg.operator !== true ? 2 : 3;
        const pending = scan.queries.filter(q => q.status === 'pending').sort((a, b) => a.priority - b.priority || a.id - b.id).slice(0, batchSize);
        const results = await Promise.allSettled(pending.map(async query => ({ query, data: await request(query.q, 'search', query.page) })));
        outcomes = results.filter(result => result.status === 'fulfilled').map(result => result.value);
        failure = results.find(result => result.status === 'rejected')?.reason || null;
      }
    } catch (error) { failure = error; }
    return update(id, current => {
      // A later tab may hold a replacement lease. Never commit stale results.
      if (current.lease_token !== token) return current;
      let next = current;
      if (planning) {
        next = appendQueries(next, seeds);
        const suggestions = outcomes.flatMap(result => Array.isArray(result.suggestions) ? result.suggestions.filter(s => typeof s === 'string') : []);
        const signals = Object.values(CATEGORY_SIGNALS).flat();
        const autos = queriesFromSuggestions(suggestions.filter(safeQuery), formsFor(next))
          .filter(result => signals.some(term => norm(result.q).includes(term)))
          .map(result => ({ title: result.q, snippet: 'Search suggestion, not evidence of an allegation or event.', kind: 'autocomplete', url: `https://www.google.com/search?q=${encodeURIComponent(result.q)}` }));
        next = appendHits(next, autos, 'autocomplete', now()).record;
      } else {
        for (const { query, data } of outcomes) {
          const inserted = appendHits(next, data?.results, query.q, now(), data?.coverage);
          // Save useful partial results, but leave that query pending for a retry.
          next = { ...inserted.record, queries: inserted.record.queries.map(q => q.id === query.id
            ? { ...q, status: data?.partial === true ? 'pending' : 'done', partial: data?.partial === true,
              results: q.results + inserted.inserted, coverage: mergeCoverage(q.coverage, inserted.coverage) } : q) };
          const related = Array.isArray(data?.related) ? data.related.filter(safeQuery) : [];
          next = appendQueries(next, queriesFromSuggestions(related, formsFor(next)));
        }
      }
      const pending = next.queries.some(q => q.status === 'pending');
      const partial = next.queries.some(q => q.partial === true);
      const code = Object.hasOwn(QUOTA_MESSAGES, failure?.code) ? failure.code : null;
      if (['search_ticket_invalid', 'search_ticket_expired', 'search_ticket_required'].includes(code)) next = { ...next, search_permit: null };
      return { ...next, partial, serp_queries: current.serp_queries + requests, lease_token: null, lease_until: 0,
        operator_access: cfg ? cfg.operator === true : current.operator_access,
        error_code: code, quota_reset_at: Number.isFinite(failure?.reset_at) ? failure.reset_at : next.search_permit?.reset_at || null,
        status: failure ? (failure.status === 429 ? 'paused_budget' : 'error') : partial ? 'error' : pending ? (next.provider === 'session' ? 'awaiting_import' : 'searching') : 'done',
        error: failure ? (code ? `${QUOTA_MESSAGES[code]}${Number.isFinite(failure.retry_after_seconds) && failure.retry_after_seconds > 0 ? ` Try again in ${Math.ceil(failure.retry_after_seconds)} seconds.` : ''}` : failure.status === 429 ? 'The search allowance has been reached. Retry later to continue.' : 'The search step could not be completed. Your local progress is saved; retry to continue.')
          : partial ? 'Some search engines did not respond. These results are incomplete. Saved mentions remain available; retry to complete the pending queries.' : null };
    });
  };

  return async function handle(path, { method = 'GET', body, scanId } = {}) {
    if (path === '/api/scan' && method === 'POST') {
      const input = createInput(body);
      if (input.help_only) return { id: null, help_only: true, show_help_first: true };
      const cfg = await config(), provider = cfg.provider || (cfg.demo ? 'mock' : 'session');
      if (!['mock', 'session', ...EXTERNAL].includes(provider)) fail(503, 'Unknown search provider configuration.');
      if (EXTERNAL.has(provider)) {
        if (cfg.search_relay_enabled !== true) fail(503, 'Live search sharing is disabled.');
        if (!input.live_search_consent) fail(403, 'Confirm sharing the search queries with the search provider before starting a live scan.');
      }
      const id = uuid(), timestamp = now();
      const googleBackup = configuredGoogleBackup(cfg);
      const fresh = { ...input, id, created_at: timestamp, provider, status: 'planning', error: null,
        google_backup_consent: input.google_backup_consent && input.live_search_consent && googleBackup === 'serpapi',
        configured_google_backup_provider: googleBackup,
        operator_access: cfg.operator === true,
        search_country_supported: provider !== 'searxng' && cfg.search_country_supported !== false,
        autocomplete_supported: !['session', 'brave', 'searxng'].includes(provider) && cfg.autocomplete_supported !== false,
        search_engines: [], configured_search_engines: provider === 'searxng' ? safeSearchEngines(cfg.search_engines) : [],
        max_queries: bounded(cfg.max_queries, 60, 60), show_limit: bounded(cfg.show_limit, VISIBLE_RESULT_LIMIT, VISIBLE_RESULT_LIMIT),
        queries: [], hits: [], drafts: [], serp_queries: 0, lease_token: null, lease_until: 0 };
      await store.put('scan', id, carryForwardFindings(fresh, await store.list('scan'), timestamp).record);
      return { id, show_help_first: input.is_minor };
    }
    let match = typeof path === 'string' && path.match(/^\/api\/scan\/([^/]+)(?:\/(queries|import|retry|attachment|history))?$/);
    if (match) {
      const [, id, action] = match;
      if (!action && method === 'GET') return report(await step(id));
      if (!action && method === 'DELETE') { await get(id); await store.remove('scan', id); return { deleted: true }; }
      if (action === 'history' && method === 'POST') {
        if (Object.keys(bodyValue(body)).length) fail(400, 'This operation only reads matching scans saved in this browser.');
        const previous = await store.list('scan');
        let carried_count = 0;
        await update(id, scan => {
          if (scan.lease_until > now()) fail(409, 'A scan step is running. Try again in a moment.');
          const carried = carryForwardFindings(scan, previous, now());
          carried_count = carried.carriedCount;
          return carried.record;
        });
        return { carried_count };
      }
      if (action === 'attachment' && method === 'GET') {
        const scan = await get(id), ids = body?.hit_ids;
        let hits;
        if (ids !== undefined) {
          if (!Array.isArray(ids) || ids.length > VISIBLE_RESULT_LIMIT || ids.some(value => !Number.isSafeInteger(value) || value < 1)) fail(400, 'Invalid result IDs.');
          hits = [...new Set(ids)].map(value => {
            const hit = scan.hits.find(hit => hit.id === value && hit.category !== 'sensitive_intimate');
            if (!hit) fail(400, 'Result does not belong to this scan or cannot be shared.');
            return hit;
          });
        } else hits = rankHits(reviewableHits(scan), Math.min(VISIBLE_RESULT_LIMIT, scan.show_limit || VISIBLE_RESULT_LIMIT), { includeNeutral: true }).shown;
        return { subject_name: scan.full_name, subject_type: scan.subject_type, country: scan.context.country,
          results: hits.map(hit => ({ url: hit.url, title: hit.title })) };
      }
      if (action === 'queries' && method === 'GET') {
        const scan = await get(id);
        if (scan.provider !== 'session') fail(400, 'Query export is available in session mode only.');
        return { queries: scan.queries.filter(q => q.status === 'pending').map(({ q, priority, source }) => ({ q, priority, source })) };
      }
      if (action === 'retry' && method === 'POST') {
        await update(id, scan => {
          if (scan.lease_until > now()) fail(409, 'A scan step is running. Try again in a moment.');
          if (!['error', 'paused_budget'].includes(scan.status)) fail(400, 'This scan does not need a retry.');
          return { ...scan, status: scan.queries.length ? (scan.provider === 'session' ? 'awaiting_import' : 'searching') : 'planning', error: null, error_code: null, lease_token: null, lease_until: 0 };
        });
        return { ok: true };
      }
      if (action === 'import' && method === 'POST') {
        const b = bodyValue(body);
        if (!Array.isArray(b.results) || b.results.length > 20) fail(400, 'Import up to 20 query results at a time.');
        const imports = b.results.map(result => {
          if (!result || !Array.isArray(result.items) || result.items.length > SEARCH_RESULT_LIMIT) fail(400, 'Invalid imported items.');
          const q = text(result.q, 500, 'query', true);
          if (!safeQuery(q)) fail(400, 'Use the specialist help resources for intimate-content concerns.');
          return { q, items: result.items.map(item => ({ title: text(item?.title, 500, 'title'), snippet: text(item?.snippet, 2000, 'snippet'), url: urlValue(item?.url, fail) })) };
        });
        let imported = 0;
        await update(id, current => {
          if (current.provider !== 'session') fail(400, 'Imports are available in session mode only.');
          if (current.lease_until > now()) fail(409, 'A scan step is running. Try again in a moment.');
          for (const result of imports) if (!current.queries.some(query => query.q === result.q)) fail(400, 'Import contains a query that does not belong to this scan.');
          let next = current;
          for (const result of imports) {
            if (!next.queries.some(query => query.q === result.q && query.status === 'pending')) continue;
            const added = appendHits(next, result.items, result.q, now()); imported += added.inserted;
            next = { ...added.record, queries: added.record.queries.map(query => query.q === result.q
              ? { ...query, status: 'done', results: added.inserted, coverage: added.coverage } : query) };
          }
          return { ...next, status: next.queries.some(q => q.status === 'pending') ? 'awaiting_import' : 'done', error: null };
        });
        return { imported };
      }
    }
    match = typeof path === 'string' && path.match(/^\/api\/hit\/(\d+)(?:\/(draft|draft-ai))?$/);
    if (match) {
      const hitId = Number(match[1]);
      if (!Number.isSafeInteger(hitId) || hitId < 1) fail(404, 'Result not found in this scan.');
      const ownedHit = scan => { const hit = scan.hits.find(hit => hit.id === hitId); if (!hit) fail(404, 'Result not found in this scan.'); return hit; };
      if (!match[2] && method === 'PATCH') {
        const b = bodyValue(body);
        if (!STATUSES.has(b.status)) fail(400, 'Invalid result status.');
        await update(scanId, scan => { ownedHit(scan); return { ...scan, hits: scan.hits.map(hit => hit.id === hitId ? { ...hit, status: b.status,
          history: hit.status === b.status ? (hit.history || []) : [...(hit.history || []), {status:b.status,at:now()}].slice(-250) } : hit) }; });
        return { id: hitId, status: b.status };
      }
      if (match[2] === 'draft-ai' && method === 'POST') {
        // Opt-in AI draft for this one result. Only its title, link, snippet,
        // platform, request type and the typed facts leave the browser; the
        // returned draft is stored here like a template draft.
        if (typeof aiDraft !== 'function') fail(404, 'AI drafting is not available.');
        const b = bodyValue(body);
        if (Object.keys(b).some(key => !['consent', 'template', 'owns_content', 'sender_email', 'facts'].includes(key))) fail(400, 'Unexpected AI draft fields.');
        if (b.consent !== true) fail(400, 'Confirm that you agree to send this one result for an AI draft.');
        if (typeof b.template !== 'string' || !b.template) fail(400, 'Choose a request type first.');
        const facts = b.facts === undefined ? '' : text(b.facts, AI_FACTS_LIMIT, 'facts to include');
        const scan = await get(scanId), hit = ownedHit(scan);
        if (hit.kind === 'autocomplete' || hit.category === 'sensitive_intimate') fail(400, 'AI drafting is available for web results only. Use the template or specialist support.');
        const info = draftInfo(scan, hit, { template: b.template, owns_content: b.owns_content, ...(b.sender_email === undefined ? {} : { sender_email: b.sender_email }) }, now());
        let host = '';
        try { host = new URL(hit.url).hostname.replace(/^www\./, ''); } catch { fail(400, 'AI drafting needs a valid web page link.'); }
        const result = await aiDraft(aiDraftPayload({ requestType: b.template, url: hit.url, title: hit.title, snippet: hit.snippet,
          platform: info.channel?.name || host, facts }), scan.search_permit?.ticket);
        if (typeof result?.draft !== 'string' || result.draft.length > 20000) fail(502, 'The AI service returned no usable draft. Use the template draft instead.');
        const senderEmail = info.sender_email || '';
        const context = { full_name: scan.full_name, email: senderEmail, url: hit.url, subject_type: scan.subject_type,
          representative_name: scan.context.representative_name, owns_content: b.owns_content === true };
        const signer = scan.subject_type === 'business' ? String(scan.context.representative_name || '') : String(scan.full_name || '');
        const local = localAiDraft(result.draft, { fallbackSubject: TEMPLATES[b.template].subject(context), name: signer.trim(), email: senderEmail });
        let draft;
        await update(scanId, current => {
          ownedHit(current);
          draft = { id: Math.max(0, ...current.drafts.map(item => item.id)) + 1, hit_id: hitId, subject: local.subject, body: local.body,
            template: b.template, owns_content: b.owns_content === true, sender_email: senderEmail, channel: info.channel || {},
            source: 'ai', ai_provider: String(result.provider || '').slice(0, 40), ai_model: String(result.model || '').slice(0, 100), created_at: now() };
          return { ...current, drafts: [...current.drafts, draft],
            hits: current.hits.map(item => item.id === hitId && item.status === 'found' ? { ...item, status: 'drafted' } : item) };
        });
        return { draft, model: draft.ai_model, provider: draft.ai_provider };
      }
      if (match[2] === 'draft' && method === 'POST') {
        const b = bodyValue(body);
        if (!b.template) { const scan = await get(scanId); return draftInfo(scan, ownedHit(scan), b, now()); }
        let result;
        await update(scanId, scan => {
          const hit = ownedHit(scan); result = draftInfo(scan, hit, b, now());
          if (!result.draft) return scan;
          return { ...scan, drafts: [...scan.drafts.filter(saved => saved.id !== result.draft.id), result.draft],
            hits: scan.hits.map(item => item.id === hitId && item.status === 'found' ? { ...item, status: 'drafted' } : item) };
        });
        return result;
      }
      if (match[2] === 'draft' && method === 'PATCH') {
        const b = bodyValue(body);
        if (typeof b.subject !== 'string' || typeof b.body !== 'string' || /[\r\n]/.test(b.subject)) fail(400, 'Enter valid draft text.');
        if (b.draft_id !== undefined && (!Number.isSafeInteger(b.draft_id) || b.draft_id < 1)) fail(400, 'Invalid draft ID.');
        const subject = text(b.subject, 180, 'draft subject'), draftBody = text(b.body, 20_000, 'draft body');
        let draft;
        await update(scanId, scan => {
          const hit = ownedHit(scan), saved = [...scan.drafts].reverse().find(item => item.hit_id === hitId && (b.draft_id === undefined || item.id === b.draft_id));
          if (!saved) fail(404, 'Generate a draft for this result before saving edits.');
          if (!templatesFor(hit, { isMinor: scan.is_minor, ownsContent: saved.owns_content === true, subjectType: scan.subject_type }).includes(saved.template)) fail(400, 'That request template is no longer available for this result.');
          draft = { ...saved, subject, body: draftBody, updated_at: now() };
          return { ...scan, drafts: scan.drafts.map(item => item.id === draft.id ? draft : item) };
        });
        return { ok: true, draft };
      }
    }
    fail(404, 'API route not found.');
  };
}
