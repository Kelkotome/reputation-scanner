import { describe, it, expect } from 'vitest';
import { TEMPLATES, templatesFor } from '../src/templates.js';

describe('removal templates', () => {
  it('asks for removal without inventing publication consent or a confirmed policy breach', () => {
    const context = { full_name: 'Alex Example', url: 'https://example.com/post' };
    for (const id of ['general_removal', 'policy_review', 'harassment', 'inaccurate', 'outdated', 'review']) {
      expect(TEMPLATES[id].subject(context)).toMatch(/remov/i);
      expect(TEMPLATES[id].body(context)).toMatch(/remov/i);
      expect(TEMPLATES[id].body(context)).toContain('[Your contact email]');
      expect(TEMPLATES[id].body(context)).not.toContain('willing to provide a response for publication');
    }
    expect(TEMPLATES.inaccurate.body(context)).toContain('if your review confirms');
  });
  it('offers relevant alternatives and only offers follow-up after a request was sent', () => {
    const hit = { category: 'harassment', status: 'found' };
    expect(templatesFor(hit)).toEqual(['inaccurate', 'general_removal', 'policy_review', 'anonymise', 'harassment']);
    expect(templatesFor(hit, { subjectType: 'business' })).not.toContain('anonymise');
    for (const status of ['sent', 'refused', 'escalated']) expect(templatesFor({ ...hit, status })).toContain('follow_up');
    for (const status of ['found', 'drafted', 'removed']) expect(templatesFor({ ...hit, status })).not.toContain('follow_up');
  });
  it('excludes business personal-info requests and preserves sensitive-content and ownership safeguards', () => {
    expect(templatesFor({ category: 'doxxing_personal_info' }, { subjectType: 'business' })).toEqual(['general_removal', 'policy_review']);
    expect(templatesFor({ category: 'neutral' }, { subjectType: 'business', ownsContent: true })).toEqual(['copyright']);
    expect(templatesFor({ category: 'neutral' }, { subjectType: 'business', ownsContent: 'true' })).toEqual([]);
    expect(templatesFor({ category: 'sensitive_intimate' }, { subjectType: 'business', ownsContent: true })).toEqual([]);
  });
  it('signs business drafts as the representative without inventing ownership or personal identity', () => {
    const context = { subject_type: 'business', full_name: 'Green Leaf Studio', representative_name: 'Ari Tan', email: 'ari@example.com', url: 'https://example.com/post' };
    for (const id of ['inaccurate', 'outdated', 'review', 'same_name', 'copyright', 'general_removal', 'policy_review', 'harassment', 'follow_up']) {
      const body = TEMPLATES[id].body(context);
      expect(body).toContain('Ari Tan\nOn behalf of Green Leaf Studio');
      expect(body).toContain(context.url);
      expect(body).toContain(context.email);
      expect(body).toContain('accurate to the best of my knowledge');
      expect(body).toContain('[');
      expect(`${TEMPLATES[id].subject(context)} ${body}`.split(/\s+/).length).toBeLessThanOrEqual(250);
      expect(body).not.toMatch(/I am the owner|My name is Green Leaf|I am not the person|anonymising my name/);
    }
    expect(TEMPLATES.copyright.body(context)).not.toContain('Green Leaf Studio owns');
    expect(TEMPLATES.copyright.body({ ...context, owns_content: true })).toContain('Green Leaf Studio owns the work');
    expect(TEMPLATES.copyright.body({ ...context, owns_content: 'true' })).not.toContain('Green Leaf Studio owns');
    expect(TEMPLATES.same_name.body(context)).toContain('a different business');
  });
  it('never offers any template for sensitive intimate content', () => {
    expect(templatesFor({ category: 'sensitive_intimate', status: 'not_me', match_confidence: 0.2 }, { ownsContent: true })).toEqual([]);
  });
  it('requires explicit adult ownership for copyright', () => {
    const hit = { category: 'doxxing_personal_info' };
    expect(templatesFor(hit, { isMinor: true, ownsContent: true })).toEqual(['personal_info', 'general_removal', 'policy_review', 'anonymise']);
    expect(templatesFor(hit, { ownsContent: true })).toContain('copyright');
    expect(templatesFor(hit, { ownsContent: 'true' })).not.toContain('copyright');
  });
  it('requires Not me plus known confidence below 0.5 for same-name letters', () => {
    expect(templatesFor({ status: 'not_me', match_confidence: 0.49 })).toEqual(['same_name']);
    for (const confidence of [0.5, undefined, null, NaN]) expect(templatesFor({ status: 'not_me', match_confidence: confidence })).not.toContain('same_name');
    expect(templatesFor({ status: 'found', match_confidence: 0.2 })).not.toContain('same_name');
  });
  it('distinguishes review sites from articles', () => {
    expect(templatesFor({ category: 'negative_news_forum', url: 'https://trustpilot.com/review/test' })).toEqual(['review', 'general_removal', 'policy_review', 'anonymise']);
    expect(templatesFor({ category: 'negative_news_forum', url: 'https://news.example.com/story' })).toEqual(['outdated', 'general_removal', 'policy_review', 'anonymise']);
    expect(templatesFor({ category: 'crime_legal' })).toEqual(['outdated', 'general_removal', 'policy_review', 'anonymise']);
  });
  it('keeps every plain draft short, signed, contactable and editable without invented evidence', () => {
    const context = { full_name: 'Alex Example', email: 'alex@example.com', url: 'https://example.com/post' };
    for (const template of Object.values(TEMPLATES)) {
      const body = template.body(context);
      expect(body).toContain(context.full_name);
      expect(body).toContain(context.email);
      expect(body).toContain(context.url);
      expect(body).toContain('accurate to the best of my knowledge');
      expect(body).toContain('[');
      expect(`${template.subject(context)} ${body}`.split(/\s+/).length).toBeLessThanOrEqual(250);
      expect(body).not.toMatch(/lawsuit|legal action|penalty of perjury/i);
    }
  });
});
