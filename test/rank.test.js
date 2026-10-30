import { describe, it, expect } from 'vitest';
import { prefilter, rankHits, shouldEarlyStop, isProfessionalListing } from '../src/rank.js';

describe('filtering and ranking', () => {
  const hit = (id, extra = {}) => ({ id, classified: 1, category: 'scam_fraud', severity: 4, match_confidence: 0.8, status: 'new', ...extra });
  it('requires the subject, deduplicates canonical URLs and shares domain caps across batches', () => {
    const state = { seen: new Set(), domainCounts: new Map() };
    const first = prefilter([
      { url: 'https://forums.example.com/a', title: 'Anne Lee scam' },
      { url: 'https://www.forums.example.com/a?utm_source=x', title: 'Anne Lee scam' },
      { url: 'https://example.com/b', title: 'Anne Lee review' },
      { url: 'https://example.com/c', title: 'Anne Lee review' },
      { url: 'https://other.com/a', title: 'A different person' },
      { url: 'https://elsewhere.com/b', title: 'Joanne Lee review' },
    ], ['anne lee'], state);
    expect(first.kept).toHaveLength(3);
    expect(first.droppedDup).toBe(1);
    expect(first.duplicates).toHaveLength(1);
    expect(first.duplicates[0].canonical_url).toBe(first.kept[0].canonical_url);
    expect(first.droppedNoName).toBe(2);
    expect(prefilter([{ url: 'https://news.example.com/d', title: 'Anne Lee review' }], ['anne lee'], state).droppedDomainCap).toBe(1);
  });
  it('returns same-batch and existing URL observations for enrichment without adding unique hits', () => {
    const state = { seen: new Set(['publisher.example/existing']) };
    const filtered = prefilter([
      { url: 'https://publisher.example/new', title: 'Anne Lee profile' },
      { url: 'https://publisher.example/new?utm_source=later', title: 'Anne Lee fraud allegation' },
      { url: 'https://publisher.example/existing', title: 'Different name' },
    ], ['anne lee'], state);
    expect(filtered.kept).toHaveLength(1);
    expect(filtered.droppedDup).toBe(2);
    expect(filtered.duplicates.map(item => item.title)).toEqual(['Anne Lee fraud allegation', 'Different name']);
  });
  it('caps shown negatives, counts the remainder and separates low-confidence names', () => {
    const rows = [...Array.from({ length: 13 }, (_, i) => hit(i)), hit(90, { status: 'not_me' }), hit(91, { category: 'neutral' }), hit(92, { match_confidence: 0.1 }), hit(93, { category: 'same_name_other_person' })];
    const result = rankHits(rows);
    expect(result.shown).toHaveLength(10);
    expect(result.moreCount).toBe(3);
    expect(result.sameNameCount).toBe(2);
    expect(result.shown.every(x => x.status !== 'not_me')).toBe(true);
  });
  it('orders by severity weighted by confidence', () => {
    expect(rankHits([hit(1, { severity: 5, match_confidence: 0.3 }), hit(2)]).shown.map(x => x.id)).toEqual([2, 1]);
  });
  it('includes ordinary name matches in broad reports without labelling them negative', () => {
    const ordinary = Array.from({ length: 12 }, (_, i) => hit(i + 10, { category: 'neutral', severity: 0 }));
    const result = rankHits([...ordinary, hit(1), hit(80, { category: 'neutral', match_confidence: 0.1 }), hit(81, { category: 'neutral', status: 'not_me' })], 10, { includeNeutral: true });
    expect(result.shown).toHaveLength(10);
    expect(result.shown[0].id).toBe(1);
    expect(result.shown.slice(1).every(row => row.category === 'neutral' && row.severity === 0)).toBe(true);
    expect(result.moreCount).toBe(3);
    expect(result.sameNameCount).toBe(1);
  });
  it('recognises ordinary professional directories by host while preserving concerning posts', () => {
    expect(isProfessionalListing({category:'neutral',url:'https://sg.linkedin.com/in/example'})).toBe(true);
    expect(isProfessionalListing({category:'neutral',url:'https://rocketreach.co/example'})).toBe(true);
    expect(isProfessionalListing({category:'neutral',url:'https://linkedin.com.attacker.example/profile'})).toBe(false);
    expect(isProfessionalListing({category:'scam_fraud',url:'https://linkedin.com/posts/complaint'})).toBe(false);
    expect(isProfessionalListing({category:'neutral',url:'https://instagram.com/example'})).toBe(false);
  });
  it('stops only after enough high severity, high confidence matches', () => {
    const strong = Array.from({ length: 10 }, (_, i) => hit(i));
    expect(shouldEarlyStop(strong)).toBe(true);
    expect(shouldEarlyStop(strong.slice(1))).toBe(false);
    expect(shouldEarlyStop(strong.map(x => ({ ...x, status: 'not_me' })))).toBe(false);
    expect(shouldEarlyStop(strong.map(x => ({ ...x, match_confidence: 0.5 })))).toBe(false);
  });
});
