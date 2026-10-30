// Carry previously saved findings into a scan without making a search request
// or asserting that the source is still available. All matching stays local.
import { canonicalUrl, hostOf, registrableDomain } from './text.js';
import { urlValue } from './takedowns.js';

const MAX_HISTORY_SCANS = 1000;
const MAX_HISTORY_HITS = 1000;
const CONTEXT_FIELDS = ['country_code', 'country', 'city', 'employer', 'school', 'representative_name', 'website', 'industry'];
const SENSITIVE_CATEGORIES = new Set(['sensitive_intimate', 'child_safety']);
const SENSITIVE = /\b(?:nudes?|nudity|naked|porn(?:ography|ographic)?|sex(?:ual)?[\s-]*(?:tapes?|videos?|images?|abuse)|intimate[\s-]+(?:images?|content|videos?)|revenge[\s-]+porn|child[\s-]+(?:sexual|abuse)|onlyfans|fansly|nsfw|xxx|xvideos?|xnxx|xhamster|hentai)\b|裸照|色情/i;
const timestamp = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const identifier = value => typeof value === 'string' && value.trim() && value.length <= 128;
const hitId = value => Number.isSafeInteger(value) && value >= 1;
const invalidUrl = () => { throw new Error('Invalid saved URL.'); };

function normalized(value) {
  if (value == null) return '';
  return typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim() : null;
}

function normalizedList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 5) return null;
  const values = value.map(normalized);
  return values.some(item => item === null || !item) ? null : [...new Set(values)].sort();
}

function identityKey(scan) {
  if (!scan || typeof scan !== 'object' || Array.isArray(scan) || typeof scan.is_minor !== 'boolean') return null;
  const context = scan.context ?? {};
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const type = scan.subject_type ?? context.subject_type ?? 'person';
  if (!['person', 'business'].includes(type) || (context.subject_type && context.subject_type !== type)) return null;
  const name = normalized(scan.full_name), variants = normalizedList(scan.variants), usernames = normalizedList(context.usernames);
  const fields = CONTEXT_FIELDS.map(field => normalized(context[field]));
  if (!name || variants === null || usernames === null || fields.some(value => value === null)) return null;
  return JSON.stringify([name, type, scan.is_minor, variants, ...fields, usernames]);
}

function sensitive(value) {
  let decoded = String(value || '');
  try { decoded = decodeURIComponent(decoded); } catch { /* Check the raw saved text. */ }
  return SENSITIVE.test(decoded.normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[+_/-]+/g, ' '));
}

function guardedScan(scan) {
  return scan.help_only === true || scan.status === 'help_only' || sensitive(scan.full_name)
    || (Array.isArray(scan.harm_types) && scan.harm_types.some(type => SENSITIVE_CATEGORIES.has(type)));
}

function observationAt(hit, previous, cutoff) {
  // The scan creation time is a fallback only for an original finding. A carried
  // finding must never acquire the creation time of an intermediate scan.
  const values = hit.discovery_origin === 'previous_scan'
    ? [hit.last_seen_at, hit.previous_observed_at, hit.created_at]
    : [hit.last_seen_at, hit.created_at, previous.created_at];
  for (const value of values) {
    const observed = timestamp(value);
    if (observed !== null) return observed < cutoff ? observed : null;
  }
  return null;
}

/** Return a new record only when safe, identity-matched historical hits exist. */
export function carryForwardFindings(scan, previousScans, now) {
  const unchanged = { record: scan, carriedCount: 0, changed: false };
  const key = identityKey(scan), created = timestamp(scan?.created_at), carriedAt = timestamp(now);
  if (!key || !identifier(scan.id) || !Array.isArray(scan.hits) || !Array.isArray(previousScans)
    || created === null || carriedAt === null || carriedAt < created || guardedScan(scan)) return unchanged;

  const candidates = previousScans.slice(0, MAX_HISTORY_SCANS).filter(previous =>
    identifier(previous?.id) && previous.id !== scan.id && timestamp(previous.created_at) !== null
    && previous.created_at < created && Array.isArray(previous.hits) && !guardedScan(previous) && identityKey(previous) === key)
    .sort((left, right) => right.created_at - left.created_at || left.id.localeCompare(right.id));
  const seen = new Set();
  for (const hit of scan.hits) {
    try { seen.add(canonicalUrl(urlValue(hit?.url, invalidUrl))); } catch { /* Do not trust an invalid cached URL. */ }
  }
  let nextId = scan.hits.reduce((max, hit) => hitId(hit?.id) ? Math.max(max, hit.id) : max, 0) + 1;
  const carried = [];
  let inspected = 0;
  for (const previous of candidates) {
    for (const hit of previous.hits) {
      if (inspected++ >= MAX_HISTORY_HITS || !Number.isSafeInteger(nextId)) break;
      if (!hit || typeof hit !== 'object' || Array.isArray(hit) || !hitId(hit.id)) continue;
      let url;
      try { url = urlValue(hit.url, invalidUrl); } catch { continue; }
      const canonical = canonicalUrl(url);
      if (seen.has(canonical)) continue;
      // A newer not-me decision or sensitive classification also suppresses any
      // older version of that URL. The current scan's row always wins outright.
      seen.add(canonical);
      if (hit.status === 'not_me' || SENSITIVE_CATEGORIES.has(hit.category)
        || sensitive(`${url} ${hit.title || ''} ${hit.snippet || ''} ${hit.source_query || ''} ${hit.context_text || ''}`)) continue;
      const observed = observationAt(hit, previous, created);
      if (observed === null) continue;
      const original = hit.discovery_origin === 'previous_scan';
      const previousObserved = timestamp(hit.previous_observed_at);
      carried.push({ ...hit, id: nextId++, url, canonical_url: canonical, domain: registrableDomain(hostOf(url)),
        ...(Object.hasOwn(hit, 'scan_id') ? { scan_id: scan.id } : {}),
        ...(Array.isArray(hit.history) ? { history: hit.history.map(item => ({ ...item })) } : {}),
        discovery_origin: 'previous_scan',
        previous_scan_id: original && identifier(hit.previous_scan_id) ? hit.previous_scan_id : previous.id,
        previous_hit_id: original && hitId(hit.previous_hit_id) ? hit.previous_hit_id : hit.id,
        previous_observed_at: original && previousObserved !== null && previousObserved < created ? previousObserved : observed,
        carried_into_at: carriedAt, last_seen_at: observed });
    }
    if (inspected >= MAX_HISTORY_HITS || !Number.isSafeInteger(nextId)) break;
  }
  return carried.length ? { record: { ...scan, hits: [...scan.hits, ...carried] }, carriedCount: carried.length, changed: true } : unchanged;
}
