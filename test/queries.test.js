import { describe, it, expect } from 'vitest';
import { buildSeedQueries, mergeQueries, queriesFromSuggestions } from '../src/queries.js';
import { nameForms, mentionsName } from '../src/text.js';

describe('query planning', () => {
  const scan = { full_name: 'Tan Wei Ming', variants: ['William Tan'], context: { employer: 'Example Ltd', usernames: ['@willtan'] } };
  it('scopes business queries with location, website and industry instead of personal details', () => {
    const business = { full_name: 'Green Leaf Studio', variants: ['GL Studio'], context: {
      subject_type: 'business', country: 'Singapore', city: 'Tampines', website: 'https://www.greenleaf.example/services',
      industry: 'Landscape design', employer: 'Unrelated Employer', school: 'Unrelated School', usernames: ['@greenleaf'],
    } };
    const queries = buildSeedQueries(business);
    for (const detail of ['Singapore', 'Tampines', 'greenleaf.example', 'Landscape design']) {
      expect(queries).toContainEqual({ q: `"Green Leaf Studio" "${detail}"`, priority: 2, source: 'seed' });
    }
    const joined = queries.map(({ q }) => q).join('\n');
    expect(joined).not.toMatch(/Unrelated Employer|Unrelated School|phone number|nric|address/);
    const forms = nameForms(business.full_name, business.variants, business.context.usernames, 'business');
    expect(queries.every(({ q }) => mentionsName(q, forms))).toBe(true);
    expect(buildSeedQueries({ ...business, subject_type: 'business', context: { ...business.context, subject_type: undefined } })).toEqual(queries);
  });
  it('includes the plain name and keeps every seed tied to the subject', () => {
    const queries = buildSeedQueries(scan);
    const forms = nameForms(scan.full_name, scan.variants, scan.context.usernames);
    expect(queries).toContainEqual({ q: '"Tan Wei Ming"', priority: 1, source: 'seed' });
    expect(queries.every(({ q }) => mentionsName(q, forms))).toBe(true);
    expect(queries.some(({ q }) => q.includes('Example Ltd'))).toBe(true);
  });
  it('deduplicates and sorts merged sources before applying the cap', () => {
    const seeds = buildSeedQueries(scan);
    const merged = mergeQueries([seeds, seeds.map(x => ({ ...x, q: x.q.toUpperCase() }))], 12);
    expect(merged).toHaveLength(12);
    expect(new Set(merged.map(x => x.q.toLowerCase())).size).toBe(12);
    expect(merged.map(x => x.priority)).toEqual(merged.map(x => x.priority).sort());
  });
  it('preserves exact and ordinary name searches in a small allowance and removes accidental trailing punctuation', () => {
    const planned = mergeQueries([buildSeedQueries({ full_name: 'Anne Lee.', variants: ['Anna Lee'], context: { usernames: ['@annelee'] } })], 4);
    expect(planned.map(x => x.q)).toEqual(['"Anne Lee"', 'Anne Lee', '"Anne Lee" news', '"Anne Lee" (scam OR scams OR fraud OR scammer)']);
    expect(mergeQueries([buildSeedQueries({full_name:'Anne Lee',variants:['Anna Lee'],context:{usernames:['@annelee']}})],24).map(x=>x.q))
      .toEqual(expect.arrayContaining(['"Anna Lee"','"annelee"']));
    expect(mergeQueries([[{q:'"Anne Lee"',priority:1}, {q:'"ANNE LEE"',priority:1}, {q:'Anne Lee',priority:1}]])).toHaveLength(2);
  });
  it('prioritises scandal, defamation, allegations and rumours alongside plain name searches',()=>{
    const planned=mergeQueries([buildSeedQueries({full_name:'Anne Lee',context:{}})],10);
    expect(planned.slice(0,2).map(x=>x.q)).toEqual(['"Anne Lee"','Anne Lee']);
    const keywordQueries=planned.filter(x=>x.source==='reputation');
    expect(keywordQueries).toHaveLength(8);
    expect(keywordQueries.every(x=>x.priority===1 && x.q.startsWith('"Anne Lee" '))).toBe(true);
    expect(keywordQueries.map(x=>x.q).join('\n')).toMatch(/defamation OR defamatory OR slander OR libel/);
    expect(keywordQueries.map(x=>x.q).join('\n')).toMatch(/scandal/);
    expect(keywordQueries).toContainEqual({q:'"Anne Lee" news',priority:1,source:'reputation'});
    expect(keywordQueries.map(x=>x.q).join('\n')).toMatch(/scam OR scams OR fraud/);
    expect(keywordQueries.map(x=>x.q).join('\n')).toMatch(/"data leak" OR "data breach" OR doxxing/);
    expect(keywordQueries.map(x=>x.q).join('\n')).not.toMatch(/\bleads\b/);
    expect(keywordQueries.map(x=>x.q).join('\n')).toMatch(/rumour OR rumor/);
    expect(keywordQueries.map(x=>x.q).join('\n')).not.toMatch(/site:|linkedin|recruiter/);
  });
  it('accepts related searches only for a complete name or handle', () => {
    expect(queriesFromSuggestions(['Joanne Lee fraud', 'Anne Leeway court', 'annelee scam', 'Anne Lee court'], ['anne lee'], 1))
      .toEqual([{ q: 'annelee scam', priority: 2, source: 'related' }]);
  });
});
