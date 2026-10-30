import { describe, it, expect } from 'vitest';
import { resultLabelView } from '../public/result-labels.js';

describe('result labels do not present estimates as verified harm', () => {
  it('does not turn an ordinary mention into a concern because of a stale high score', () => {
    const labels = resultLabelView({ category: 'neutral', severity: 5, match_confidence: .9 });
    expect(labels.tone).toBe('ordinary');
    expect(labels.priority).toBe('context');
    expect(labels.topicLabel).not.toContain('concern');
    expect(labels.explanation).toContain('does not establish');
    expect(labels.identityExplanation).toContain('not verification');
  });
  it('gives an excluded identity priority over an old harm score and respects business wording', () => {
    const labels = resultLabelView({ category: 'scam_fraud', status: 'not_me', severity: 5 }, { business: true });
    expect(labels.tone).toBe('identity');
    expect(labels.priority).toBe('identity');
    expect(labels.identityLabel).toBe('Marked as a different business');
    expect(labels.topicLabel).not.toMatch(/fraud|scam/);
    expect(labels.explanation).toContain('Confirm the identity');
  });
  it.each([undefined, null, NaN, Infinity, '0.9'])('does not assert identity from malformed confidence %s', match_confidence => {
    const labels = resultLabelView({ category: 'crime_legal', severity: 4, match_confidence });
    expect(labels.identityLabel).toBe('Identity not confirmed');
    expect(labels.topicLabel).toContain('Possible concern');
    expect(labels.explanation).toContain('unrelated content');
    expect(labels.priorityExplanation).toContain('not a measure of danger or proof of harm');
  });
  it('does not reflect arbitrary saved category or reason text into the new label', () => {
    const labels = resultLabelView({ category: '<script>private category</script>', severity: 5, reason: 'Unverified guilty claim' });
    expect(labels.tone).toBe('ordinary');
    expect(labels.priority).toBe('context');
    expect(JSON.stringify(labels)).not.toMatch(/script|private category|guilty/);
    expect(labels.explanation).toContain('No recognised topic label');
  });
});
