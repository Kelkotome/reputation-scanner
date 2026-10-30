// Builds the reputation search list. Common patterns are individual queries.
// The long tail is grouped with OR to keep SERP cost down.

import { TERMS, SITES } from './lexicon.js';
import { norm, mentionsName, hostOf, isBusinessSubject } from './text.js';

const TOP_PATTERNS = ['scam', 'fraud', 'police', 'court', 'scandal', 'review', 'complaint'];
const REPUTATION_PATTERNS = [
  ['news'], ['scam', 'scams', 'fraud', 'scammer'], ['scandal'],
  ['defamation', 'defamatory', 'slander', 'libel', 'allegation', 'accusations', 'accused'],
  ['rumour', 'rumor', 'rumours', 'rumors'], ['exposed', 'expose', 'call out', 'callout'],
  ['complaint', 'bad review', 'warning', 'harassment', 'threats'], ['data leak', 'data breach', 'doxxing', 'private information', 'personal data'],
];

// Quotes and operators change search intent and must survive deduplication.
export const queryKey = (q, page = 1) => `${String(q || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()}${page > 1 ? `\npage:${page}` : ''}`;

function quote(s) { return `"${String(s).replace(/"/g, '').trim()}"`; }
function orGroup(terms) {
  return '(' + terms.map((t) => (t.includes(' ') ? quote(t) : t)).join(' OR ') + ')';
}

/**
 * @param {{full_name:string, variants?:string[], context?:object}} scan
 * @returns {{q:string, priority:number, source:string}[]}
 */
export function buildSeedQueries(scan) {
  const ctx = scan.context || {};
  const business = isBusinessSubject(scan);
  const terms = business ? TERMS.filter((x) => x.cat !== 'doxxing_personal_info') : TERMS;
  const name = String(scan.full_name).trim().replace(/[.,;:!?]+$/, '').trim();
  const qn = quote(name);
  const out = [];
  const push = (q, priority, source = 'seed') => out.push({ q, priority, source });

  // 0. The plain name: shows what page 1 looks like for anyone who searches it.
  push(qn, 1);
  // A normal unquoted search can return mentions omitted by an exact phrase.
  push(name, 1);
  // In a small public allowance, complete the subject's reputation searches
  // before extra alias/handle queries. Aliases still participate in matching.
  for (const v of (scan.variants || []).slice(0, 3)) {
    if (norm(v) && norm(v) !== norm(name)) push(quote(v), 2);
  }
  for (const u of (ctx.usernames || []).slice(0, 3)) {
    const handle = String(u).replace(/^@/, '').trim();
    if (handle.length >= 3) push(quote(handle), 2);
  }

  // These fit alongside the broad name requests in a public scan's allowance.
  // A search term is a discovery hint, never a finding that a claim is false.
  for (const pattern of REPUTATION_PATTERNS) push(`${qn} ${pattern.length === 1 ? pattern[0] : orGroup(pattern)}`, 1, 'reputation');

  // 1. Individual top patterns.
  for (const t of TOP_PATTERNS) {
    const term = terms.find((x) => x.t === t);
    push(`${qn} ${t}`, Math.max(2, term ? term.p : 2));
  }

  // 2. Remaining terms grouped by priority with OR.
  for (const p of [1, 2, 3]) {
    const rest = terms.filter((x) => x.p === p && !TOP_PATTERNS.includes(x.t)).map((x) => x.t);
    for (let i = 0; i < rest.length; i += 6) push(`${qn} ${orGroup(rest.slice(i, i + 6))}`, Math.max(2, p));
  }

  // 3. Variants / aliases: one grouped negative query each.
  const negCore = ['scam', 'fraud', 'police', 'scandal', 'complaint', 'exposed'];
  for (const v of (scan.variants || []).slice(0, 3)) {
    if (norm(v) && norm(v) !== norm(name)) push(`${quote(v)} ${orGroup(negCore)}`, 2);
  }

  // 4. Context combos cut same-name noise using the appropriate subject details.
  const contextTerms = business
    ? [ctx.country, ctx.city, hostOf(ctx.website), ctx.industry]
    : [ctx.employer, ctx.school];
  for (const c of contextTerms.filter(Boolean)) push(`${qn} ${quote(c)}`, 2);

  // 5. Usernames / handles.
  for (const u of (ctx.usernames || []).slice(0, 3)) {
    const h = String(u).replace(/^@/, '').trim();
    if (h.length >= 3) push(`${quote(h)} ${orGroup(negCore)}`, 2);
  }

  // 6. Site-scoped.
  for (const s of SITES) push(`site:${s} ${qn}`, 4, 'site');

  return out;
}

/** Merge query sources, dedupe case-insensitively, sort by priority, cap. */
export function mergeQueries(lists, max = 60) {
  const seen = new Set();
  const all = [];
  for (const list of lists) {
    for (const item of list || []) {
      const key = queryKey(item.q, item.page);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      all.push(item);
    }
  }
  all.sort((a, b) => a.priority - b.priority);
  return all.slice(0, max);
}

/** Related searches / autocomplete suggestions become extra queries only if they contain the name. */
export function queriesFromSuggestions(suggestions, forms, max = 10) {
  const out = [];
  for (const s of suggestions || []) {
    if (!mentionsName(s, forms)) continue;
    out.push({ q: s, priority: 2, source: 'related' });
    if (out.length >= max) break;
  }
  return out;
}
