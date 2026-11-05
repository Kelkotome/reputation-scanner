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
  describe('only flags concern wording about the person', () => {
    const esther = { full_name: 'Esther Tan', context: {} };
    const fb = 'https://www.facebook.com/dbs.sg/posts/1';
    it.each([
      ['comment author', 'China scam alert for food delivery - Facebook', fb, '... Just hang up. 1y · 1 like. Esther Tan. Scammers are damn sickening, always out to cheat others . 1y · 1 like.', 'commenter'],
      ['comment praising an arrest', 'I want to lay a trap - DBS', fb, '02.2026 ... Esther Tan. Excellent team work by all involved to arrest this hideous scammer 37w. Jens Homepreneur.', 'commenter'],
      ['poster arrow', 'Other posts - Shopping Mall', fb, '3 Tagen ... Esther Tan ▻ SG Singapore Online Shopping Mall. 5m · Public. 0 ... Dear scammers, Please remove my number from your scam list.', 'commenter'],
      ['comment after a fragment', 'Refused to reveal details about the case', fb, '... scandalising the court. 5y · 5 ... Esther Tan. Trying to tarnish our Singapore Police Force by telling a ...', 'commenter'],
      ['hospital footer', 'Dr Esther Tan - General Hospital', 'https://www.example-hospital.sg/doctor/Esther_Tan', 'Dr Esther Tan is a Senior Consultant in Emergency Medicine ... Beware of Scam Calls. We will NEVER ask you to transfer money', 'elsewhere_on_page'],
      ['lawyer biography', 'Esther Tan - Partners', 'https://www.lawfirm.example/people/90', 'She was admitted as an Advocate of the High Court of Malaya in 2014. Esther is principally involved in dispute resolution.', 'elsewhere_on_page'],
      ['newspaper byline', "'But officer, I was having a seizure'", 'https://eresources.nlb.gov.sg/newspapers/1', "Esther Tan - Esther Tan MAN ARRESTED OVER 'DRUNKEN BEHAVIOUR' Epileptic's mum claims she wasn't allowed to give son his medicine in lock-up. He found himself handcuffed and inside a police", 'writer'],
      ['headline before an archive byline', 'The Straits Times, Page 21', 'https://eresources.nlb.gov.sg/newspapers/2', 'Lorry hits traffic cop on BKE Esther Tan - Esther Tan By A TRAFFIC police officer, who stopped to help the driver, was knocked down', 'writer'],
      ['cut-off archive byline', 'The Straits Times, Page 21', 'https://eresources.nlb.gov.sg/newspapers/3', '... Esther Tan By A TRAFFIC police officer, who stopped to help the driver, was knocked down', 'writer'],
      ['defence counsel', 'Lawyer charged with threatening fellow practitioner', 'https://www.nst.com.my/news/nation/1', 'Deputy public prosecutor Syafiq Hasim prosecuted while the accused was represented by counsel Esther Tan Siew Choo.', 'case_role'],
      ['by-line', 'Man charged in court over scam', 'https://news.example/2', 'By Esther Tan. A man was charged in court with fraud on Monday.', 'writer'],
    ])('does not flag a %s', (_, title, url, snippet, mention_note) => {
      expect(classifyHeuristic(esther, { title, url, snippet })).toMatchObject({ category: 'neutral', severity: 1, mention_note });
    });
    it.each([
      ['Esther Tan is a scammer - Facebook', fb, 'Took my deposit.', 'scam_fraud'],
      ['Warning to buyers', fb, 'Please avoid Esther Tan, the scammer who took my deposit.', 'scam_fraud'],
      ['Warning to buyers', fb, 'I reported Esther Tan. She was arrested by police last week.', 'crime_legal'],
      ['Local news', 'https://news.example/1', 'Esther Tan, 34, was charged in court on Monday.', 'crime_legal'],
      ['Lawyer Esther Tan charged with fraud', 'https://news.example/3', 'A lawyer appeared in court on Monday.', 'scam_fraud'],
      ['Warning to buyers', 'https://forum.example/1', 'I was scammed by Esther Tan last year.', 'scam_fraud'],
      ['Esther Tan home address leaked', 'https://forum.example/2', 'Her details were posted here.', 'doxxing_personal_info'],
    ])('still flags direct wording: %s', (title, url, snippet, category) => {
      expect(classifyHeuristic(esther, { title, url, snippet }).category).toBe(category);
    });
    it('keeps a professional listing with an email address ordinary', () => {
      expect(classifyHeuristic(esther, { title: 'Esther Tan - The Law Society', url: 'https://solicitors.lawsociety.org.uk/person/1/esther-tan',
        snippet: 'Esther Tan. SRA Regulated. Telephone: 01502532700; Email: Show email address. Director at Example Limited, Lowestoft, ...' })).toMatchObject({ category: 'neutral', severity: 0 });
    });
    it('falls back to the whole result when the name is only in the address', () => {
      expect(classifyHeuristic(esther, { title: 'Scam warning', url: 'https://news.example/esther-tan', snippet: 'A local fraud case' }).category).toBe('scam_fraud');
    });
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
