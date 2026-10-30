import { describe, it, expect } from 'vitest';
import { platformFor, googleChannelFor, GOOGLE_CHANNELS, allLinks } from '../src/platforms.js';

describe('removal channels', () => {
  it('routes Telegram reports and copyright separately, and Tumblr to its form', () => {
    expect(platformFor('https://t.me/example/123').email).toBe('abuse@telegram.org');
    expect(platformFor('https://telegram.me/example/123', { template: 'copyright' }).email).toBe('dmca@telegram.org');
    expect(platformFor('https://example.t.me/123').email).toBe('abuse@telegram.org');
    expect(platformFor('https://example.tumblr.com/post/123').form).toBe('https://www.tumblr.com/abuse');
    expect(platformFor('https://t.me.evil.example/123')).toBeNull();
    expect(platformFor('https://tumblr.com.evil.example/123')).toBeNull();
  });
  it('maps subdomains and compound Singapore domains to their platform', () => {
    expect(platformFor('https://old.reddit.com/r/example/comments/a').name).toBe('Reddit');
    expect(platformFor('https://forums.hardwarezone.com.sg/threads/123').name).toBe('HardwareZone Forums');
    expect(platformFor('https://reddit.com.example.org/a')).toBeNull();
    expect(platformFor('https://unknown.example/a')).toBeNull();
  });
  it('selects appropriate secondary Google channels', () => {
    expect(googleChannelFor('doxxing_personal_info')).toBe(GOOGLE_CHANNELS.personal_info);
    expect(googleChannelFor('defamation_accusation')).toBe(GOOGLE_CHANNELS.legal);
    expect(googleChannelFor('negative_news_forum')).toBe(GOOGLE_CHANNELS.outdated);
  });
  it('exposes only usable HTTPS URL strings for the link checker', () => {
    expect(allLinks().length).toBeGreaterThan(10);
    for (const link of allLinks()) expect(new URL(link).protocol).toBe('https:');
  });
});
