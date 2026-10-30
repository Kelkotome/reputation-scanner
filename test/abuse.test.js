import { describe, it, expect, vi } from 'vitest';
import { parseRdap, lookupAbuse } from '../src/abuse.js';

const entity = (roles, name, email, children = []) => ({ roles, vcardArray: ['vcard', [['fn', {}, 'text', name], ['email', {}, 'text', email]]], entities: children });
const json = (data) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const registrar = { entities: [entity(['registrar'], 'Example Registrar', 'owner@registrar.com', [entity(['abuse'], 'Abuse Desk', 'ABUSE@registrar.com')])] };

describe('RDAP contacts', () => {
  it('recursively extracts only abuse emails and registrar names, deduplicating', () => {
    const data = { entities: [...registrar.entities, entity(['registrant'], 'Private Person', 'person@example.com'), entity(['abuse'], 'Abuse Desk', 'abuse@registrar.com')] };
    expect(parseRdap(data)).toEqual({ orgs: ['Example Registrar'], abuseEmails: ['abuse@registrar.com'] });
    expect(parseRdap(null)).toEqual({ orgs: [], abuseEmails: [] });
  });
  it('tolerates malformed or cyclic entities without exposing registrant details', () => {
    const cyclic = { entities: [], roles: 'abuse', vcardArray: ['vcard', 'bad'] };
    cyclic.entities.push(cyclic);
    expect(parseRdap(cyclic)).toEqual({ orgs: [], abuseEmails: [] });
  });
  it('resolves registrar and network contacts and recognises Cloudflare', async () => {
    const mock = vi.fn(async (url) => {
      if (url.includes('/domain/')) return json(registrar);
      if (url.includes('/dns-query')) return json({ Status: 0, Answer: [{ type: 1, data: '104.16.1.2' }] });
      return json({ name: 'CLOUDFLARENET', entities: [entity(['registrant'], 'Cloudflare, Inc.', '', [entity(['abuse'], 'Abuse', 'abuse@cloudflare.com')])] });
    });
    expect(await lookupAbuse('https://publicsite.com/page', mock)).toEqual({ registrar: 'Example Registrar', registrarAbuse: 'abuse@registrar.com', host: 'Cloudflare, Inc.', hostAbuse: 'abuse@cloudflare.com', cloudflare: 'https://abuse.cloudflare.com' });
    expect(mock).toHaveBeenCalledTimes(3);
    expect(mock.mock.calls.every(([url]) => !url.startsWith('https://publicsite.com'))).toBe(true);
  });
  it('refuses unsafe URLs and private DNS answers', async () => {
    const mock = vi.fn(async (url) => url.includes('/domain/') ? json(registrar) : json({ Status: 0, Answer: [{ type: 1, data: '127.0.0.1' }] }));
    for (const url of ['file:///test', 'https://127.0.0.1', 'https://[::1]', 'https://x.local', 'https://user:pass@website.com']) {
      expect((await lookupAbuse(url, mock)).host).toBeNull();
    }
    expect(mock).not.toHaveBeenCalled();
    expect((await lookupAbuse('https://publicsite.com', mock)).host).toBeNull();
    expect(mock.mock.calls.some(([url]) => url.includes('/ip/'))).toBe(false);
  });
  it('checks redirect destinations and rejects a redirect to a private address', async () => {
    const mock = vi.fn(async (url) => url.includes('/domain/')
      ? new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } })
      : json({ Status: 3 }));
    expect((await lookupAbuse('https://publicsite.com', mock)).registrar).toBeNull();
    expect(mock.mock.calls.some(([url]) => url.includes('/secret'))).toBe(false);
  });
  it('follows verified public RDAP redirects', async () => {
    const mock = vi.fn(async (url) => {
      if (url.startsWith('https://rdap.org/')) return new Response(null, { status: 302, headers: { location: 'https://rdap.registrar.com/domain/test' } });
      if (url.startsWith('https://rdap.registrar.com/')) return json(registrar);
      return json(url.includes('name=rdap.registrar.com') ? { Status: 0, Answer: [{ type: 1, data: '8.8.8.8' }] } : { Status: 3 });
    });
    expect((await lookupAbuse('https://publicsite.com', mock)).registrar).toBe('Example Registrar');
  });
  it('coalesces lookups in a caller-owned request cache without a global cache', async () => {
    const mock = vi.fn(async (url) => url.includes('/domain/') ? json(registrar) : json({ Status: 3 }));
    const cache = new Map();
    await Promise.all([lookupAbuse('https://publicsite.com/a', mock, cache), lookupAbuse('https://publicsite.com/b', mock, cache)]);
    expect(mock).toHaveBeenCalledTimes(2);
    await lookupAbuse('https://publicsite.com/c', mock);
    expect(mock).toHaveBeenCalledTimes(4);
  });
  it('bounds lookup time and returns partial contacts on network failures', async () => {
    vi.useFakeTimers();
    try {
      const mock = vi.fn((url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
      const result = lookupAbuse('https://publicsite.com', mock);
      await vi.advanceTimersByTimeAsync(4000);
      expect((await result).hostAbuse).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});
