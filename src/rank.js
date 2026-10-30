// Pre-filter (runs before any AI cost) and ranking / 10-hit cap.

import { canonicalUrl, hostOf, registrableDomain, mentionsName } from './text.js';
import { NEGATIVE_CATEGORIES } from './lexicon.js';

const PROFESSIONAL_DOMAINS = new Set(['linkedin.com', 'xing.com', 'rocketreach.co', 'zoominfo.com', 'signalhire.com', 'contactout.com', 'crunchbase.com', 'theorg.com', 'dnb.com']);
export function isProfessionalListing(hit) {
  // Use actual publisher hosts, never words in a path or an attacker suffix.
  return hit.category === 'neutral' && (PROFESSIONAL_DOMAINS.has(registrableDomain(hostOf(hit.url)))
    || /\b(?:resume|curriculum vitae|recruiter|professional profile|business directory|company profile|co[.,]{0,2}\s*ltd)\b/i.test(hit.title || ''));
}

/**
 * Keep results that mention a name form, dedupe by canonical URL, cap hits per domain.
 * @param {{url:string,title?:string,snippet?:string}[]} results
 * @param {string[]} forms
 * @param {{seen?:Set<string>, domainCounts?:Map<string,number>, domainCap?:number}} state
 */
export function prefilter(results, forms, { seen = new Set(), domainCounts = new Map(), domainCap = 3 } = {}) {
  const kept = [], duplicates = [];
  let droppedNoName = 0, droppedDup = 0, droppedDomainCap = 0;
  for (const r of results || []) {
    if (!r || !r.url) continue;
    const canon = canonicalUrl(r.url);
    if (seen.has(canon)) {
      droppedDup++;
      duplicates.push({ ...r, canonical_url: canon, domain: registrableDomain(hostOf(r.url)) });
      continue;
    }
    if (!resultMentionsName(r, forms)) { droppedNoName++; continue; }
    const dom = registrableDomain(hostOf(r.url));
    const n = domainCounts.get(dom) || 0;
    if (n >= domainCap) { droppedDomainCap++; continue; }
    domainCounts.set(dom, n + 1);
    seen.add(canon);
    kept.push({ ...r, canonical_url: canon, domain: dom });
  }
  return { kept, duplicates, droppedNoName, droppedDup, droppedDomainCap };
}

export function resultMentionsName(result, forms) {
  return mentionsName(`${result.title || ''} ${result.snippet || ''} ${decodeURIComponentSafe(result.url)}`, forms);
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s).replace(/[-_/+]/g, ' '); } catch { return s; }
}

export function isNegative(h) {
  return h.classified && NEGATIVE_CATEGORIES.has(h.category) && (h.severity || 0) >= 2
    && h.status !== 'not_me';
}

export function score(h) {
  return (h.severity || 0) * (0.25 + 0.75 * (h.match_confidence ?? 0.5));
}

/** Rank flagged mentions first; broad reports also retain ordinary name matches. */
export function rankHits(hits, limit = 10, { includeNeutral = false } = {}) {
  const eligible = h => isNegative(h) || (includeNeutral && h.classified && h.category === 'neutral' && h.status !== 'not_me');
  const mentions = hits.filter((h) => eligible(h) && (h.match_confidence ?? 0.5) >= 0.3);
  mentions.sort((a, b) => Number(isNegative(b)) - Number(isNegative(a)) || score(b) - score(a) || (b.severity || 0) - (a.severity || 0));
  const sameName = hits.filter((h) => h.classified && (h.category === 'same_name_other_person'
    || (eligible(h) && (h.match_confidence ?? 0.5) < 0.3)));
  return { shown: mentions.slice(0, limit), moreCount: Math.max(0, mentions.length - limit), sameNameCount: sameName.length };
}

/** Early stop: enough strong, confident negatives found, so low-priority queries can be skipped. */
export function shouldEarlyStop(hits, limit = 10) {
  return hits.filter((h) => isNegative(h) && h.severity >= 4 && (h.match_confidence ?? 0) >= 0.7).length >= limit;
}
