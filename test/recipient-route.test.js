import { describe, it, expect } from 'vitest';
import { recipientRoute } from '../public/recipient-route.js';
import { platformFor } from '../src/platforms.js';

describe('automatic reporting recipient', () => {
  it('selects the published Telegram address and its verification source', () => {
    expect(recipientRoute(platformFor('https://t.me/example/2'))).toMatchObject({ kind: 'email', email: 'abuse@telegram.org', url: 'https://telegram.org/faq' });
    expect(recipientRoute(platformFor('https://t.me/example/2', { template: 'copyright' })).email).toBe('dmca@telegram.org');
  });
  it('prefers a required platform form to any email and clears the previous recipient', () => {
    expect(recipientRoute(platformFor('https://example.tumblr.com/post/1'))).toMatchObject({ kind: 'form', email: '', url: 'https://www.tumblr.com/abuse' });
    expect(recipientRoute({ name: 'Test', form: 'https://example.com/report', email: 'test@example.com', source: 'https://example.com/help' }).kind).toBe('form');
    expect(recipientRoute(platformFor('https://reddit.com/r/example'))).toMatchObject({ kind: 'form', email: '' });
  });
  it('never guesses a mailbox or treats an unverified or malformed address as automatic', () => {
    expect(recipientRoute(null)).toMatchObject({ kind: 'unknown', email: '' });
    expect(recipientRoute({ email: 'abuse@example.com' })).toMatchObject({ kind: 'manual', email: '' });
    expect(recipientRoute({ email: 'a@example.com,b@example.com', source: 'https://example.com' }).email).toBe('');
    expect(recipientRoute({ email: 'a@example.com', source: 'javascript:alert(1)' }).email).toBe('');
  });
});
