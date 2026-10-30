import { describe, it, expect } from 'vitest';
import { norm, nameForms, mentionsName, canonicalUrl, registrableDomain, isBusinessSubject } from '../src/text.js';

describe('identity text helpers', () => {
  it('preserves business word order while accepting explicit aliases and handles', () => {
    const forms = nameForms('Green Leaf Studio', ['GL Studio'], ['@greenleaf'], 'business');
    expect(forms).toEqual(['green leaf studio', 'gl studio', 'greenleaf']);
    expect(mentionsName('Leaf Studio Green complaint', forms)).toBe(false);
    expect(isBusinessSubject({ context: { subject_type: 'business' } })).toBe(true);
    expect(isBusinessSubject({ subject_type: 'business' })).toBe(true);
    expect(isBusinessSubject({ context: {} })).toBe(false);
  });
  it('normalises accents, aliases and surname orders without duplicates', () => {
    expect(norm('  JOSÉ   Tan! ')).toBe('jose tan');
    expect(nameForms('Tan Wei Ming', ['TAN WEI MING', 'William Tan'], ['@will.tan']))
      .toEqual(['tan wei ming', 'william tan', 'will.tan', 'wei ming tan', 'ming tan wei']);
  });
  it('retains legitimate two-character names and aliases while filtering short handles', () => {
    expect(nameForms('王明', ['阿明', '王明'], ['@wm', '@wangming']))
      .toEqual(['王明', '阿明', 'wangming']);
    expect(nameForms('Li', ['王明'], ['@li', '@lix']))
      .toEqual(['li', '王明', 'lix']);
  });
  it.each(['Anne Lee said hello', 'Meet @annelee.', 'anne.lee review', 'Anne-Lee complaint', "Anne Lee’s profile"])
  ('recognises complete name phrases and handles: %s', text => {
    expect(mentionsName(text, ['anne lee'])).toBe(true);
  });
  it.each(['Joanne Lee', 'Anne Leeway', '@joannelee', 'annex leeds', 'someone else'])
  ('does not confuse a name substring with a person: %s', text => {
    expect(mentionsName(text, ['anne lee'])).toBe(false);
  });
  it('strips tracking parameters and fragments but preserves identity-bearing query values', () => {
    expect(canonicalUrl('https://WWW.Example.COM/story/?utm_source=email&id=42&fbclid=abc#reply'))
      .toBe('example.com/story?id=42');
    expect(canonicalUrl('http://m.example.com/story?id=42')).toBe('example.com/story?id=42');
  });
  it('handles Singapore compound suffixes and ordinary hosts', () => {
    expect(registrableDomain('forums.hardwarezone.com.sg')).toBe('hardwarezone.com.sg');
    expect(registrableDomain('www.example.com.')).toBe('example.com');
    expect(registrableDomain('localhost')).toBe('localhost');
  });
});
