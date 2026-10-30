import { describe, it, expect, vi } from 'vitest';
import { classifyHeuristic, classifyWithClaude } from '../src/classify.js';
import { CATEGORY_LABELS, NEGATIVE_CATEGORIES } from '../src/lexicon.js';

describe('result classification', () => {
  const scan = { full_name: 'Anne Lee', context: { country: 'Singapore', employer: 'Example Studio' } };
  const business = { full_name: 'Green Leaf Studio', context: { subject_type: 'business', website: 'https://greenleaf.example', industry: 'Landscape design', employer: 'Unused Employer', school: 'Unused School' } };
  it('treats public business contact information as neutral without hiding explicit personal leaks', () => {
    const directory = classifyHeuristic(business, { title: 'Green Leaf Studio address and phone number', snippet: 'Office contact number and public number for landscape design enquiries.' });
    expect(directory).toMatchObject({ category: 'neutral', severity: 0 });
    expect(directory.match_confidence).toBeCloseTo(0.6);
    for (const snippet of ['Owner home address and NRIC', 'Employee private phone number']) {
      expect(classifyHeuristic(business, { title: business.full_name, snippet }).category).toBe('doxxing_personal_info');
    }
  });
  it('uses business website identity and industry without employer, school or lookalike-domain matches', () => {
    expect(classifyHeuristic(business, { url: 'https://news.greenleaf.example/about', title: 'Green Leaf Studio', snippet: 'Landscape design' }).match_confidence).toBeCloseTo(0.8);
    expect(classifyHeuristic(business, { title: 'Green Leaf Studio', snippet: 'Visit greenleaf.example for landscape design' }).match_confidence).toBeCloseTo(0.8);
    expect(classifyHeuristic(business, { url: 'https://greenleaf.example.attacker.test', title: 'Green Leaf Studio', snippet: 'Unused Employer Unused School greenleaf.example.attacker.test' }).match_confidence).toBe(0.4);
    expect(classifyHeuristic({ ...business, context: { ...business.context, industry: 'IT' } }, { title: 'Green Leaf Studio', snippet: 'Hospitality directory' }).match_confidence).toBe(0.4);
  });
  it('keeps a clean profile neutral and uses context for identity confidence', () => {
    const result = classifyHeuristic(scan, { title: 'Anne Lee profile', snippet: 'Designer at Example Studio in Singapore' });
    expect(result.category).toBe('neutral');
    expect(result.severity).toBe(0);
    expect(result.match_confidence).toBeCloseTo(0.8);
  });
  it.each([
    ['Anne Lee fraud scam money not returned', 'scam_fraud'],
    ['Anne Lee police arrested court', 'crime_legal'],
    ['Anne Lee home address and phone number', 'doxxing_personal_info'],
    ['Anne Lee terrible complaint worst', 'negative_news_forum'],
  ])('recognises reputation category in %s', (title, category) => {
    const result = classifyHeuristic(scan, { title });
    expect(result.category).toBe(category);
    expect(result.severity).toBeGreaterThanOrEqual(2);
    expect(result.severity).toBeLessThanOrEqual(5);
    expect(result.match_confidence).toBe(0.4);
  });
  it('normalises AI classifications, preserves ids and ignores unknown categories', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ content: [{ type: 'tool_use', input: { results: [
      { id: 1, category: 'scam_fraud', severity: 8, match_confidence: 2, reason: 'An allegation appears in the snippet.' },
      { id: 2, category: 'neutral', severity: -2, match_confidence: -0.1, reason: 'Profile.' },
      { id: 3, category: 'invented_category', severity: 4, match_confidence: 0.7, reason: 'Invalid.' },
    ] } }], usage: { input_tokens: 20, output_tokens: 10 } }));
    const result = await classifyWithClaude({ CLOUD_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' }, scan, [{ id: 1 }, { id: 2 }, { id: 3 }], fetchImpl);
    expect(result.results.get(1)).toMatchObject({ category: 'scam_fraud', severity: 5, match_confidence: 1 });
    expect(result.results.get(2)).toMatchObject({ category: 'neutral', severity: 0, match_confidence: 0 });
    expect(result.results.has(3)).toBe(false);
    expect(result.usage).toEqual({ in: 20, out: 10 });
  });
  it('provides business-specific context and directory guidance to an explicitly enabled model', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ content: [{ type: 'tool_use', input: { results: [] } }] }));
    await classifyWithClaude({ CLOUD_AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'test-key' }, business, [], fetchImpl);
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(request.messages[0].content).toContain('Website: https://greenleaf.example');
    expect(request.messages[0].content).toContain('Industry: Landscape design');
    expect(request.messages[0].content).not.toMatch(/Unused Employer|Unused School/);
    expect(request.system[0].text).toContain('public office addresses and customer contact numbers are neutral');
  });
  it('provides a display label for every negative category', () => {
    for (const category of NEGATIVE_CATEGORIES) expect(CATEGORY_LABELS[category]).toBeTypeOf('string');
  });
});
