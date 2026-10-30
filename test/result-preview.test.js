import { describe, it, expect } from 'vitest';
import { additionalResultPreview } from '../public/result-preview.js';

describe('additional-link contact preview', () => {
  it('groups domains without exposing full URLs, titles, snippets or identifiers', () => {
    const preview = additionalResultPreview([
      { id: 11, url: 'https://www.publisher.example/private-name?token=secret', title: 'Private title', snippet: 'Private details' },
      { id: 12, url: 'https://publisher.example/another-private-path#private' },
      { id: 13, url: 'https://forum.example/post/secret' },
    ]);
    expect(preview).toEqual({ count: 3, sources: [{ domain: 'publisher.example', count: 2 }, { domain: 'forum.example', count: 1 }] });
    expect(JSON.stringify(preview)).not.toMatch(/private|secret|title|snippet|https:|token/i);
  });
  it('does not expose invalid, credentialed or script URLs', () => {
    expect(additionalResultPreview([{ url: 'javascript:alert(1)' }, { url: 'https://secret:password@host.example/private' }, { url: 'not a url' }]))
      .toEqual({ count: 3, sources: [{ domain: 'Source unavailable', count: 3 }] });
  });
  it('has no preview when there are no additional links', () => {
    expect(additionalResultPreview()).toEqual({ count: 0, sources: [] });
  });
});
