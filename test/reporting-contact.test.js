import { describe, it, expect, vi } from 'vitest';
import { reportingHost, discoverReportingContact } from '../src/reporting-contact.js';
import { channelForUrl } from '../src/takedowns.js';
const response = value => Response.json(value);
const abuse = email => ({ roles: ['abuse'], vcardArray: ['vcard', [['email', {}, 'text', email]]] });
function provider({ cloudflare = false, redirect = false, privateIp = false, empty = false } = {}) {
  return vi.fn(async url => {
    if (url.startsWith('https://data.iana.org/')) return response({ services: [[[url.endsWith('/dns.json') ? 'com' : '104.0.0.0/8'], ['https://registry.example.net/']]] });
    if (url.includes('dns-query')) return response({ Status: 0, Answer: [{ type: 1, data: privateIp ? '127.0.0.1' : '104.16.1.2' }] });
    if (url.includes('/domain/')) {
      if (redirect) return new Response(null, { status: 302, headers: { Location: 'https://attacker.example.net/domain/anything' } });
      return response(empty ? {} : { entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'Registrar']]], entities: [abuse('abuse@registrar.net')] }] });
    }
    if (url.includes('/ip/')) return response(empty ? {} : { name: cloudflare ? 'CLOUDFLARENET' : 'Network operator', entities: [abuse('abuse@network.net')] });
    throw new Error('Unexpected fetch');
  });
}
describe('domain-only contact routing', () => {
  it('accepts ordinary and adult hostnames without accepting URLs or private targets', () => {
    expect(reportingHost('adult-platform.com')).toBe('adult-platform.com');
    for (const host of ['https://example.com/private-path', '127.0.0.1', 'localhost', 'x.internal', 'x.onion', 'a..com', 'user@example.com']) expect(() => reportingHost(host)).toThrow();
  });
  it('returns separate network and registrar contacts without fetching any reported site', async () => {
    const fetcher = provider(), result = await discoverReportingContact('adult-platform.com', fetcher);
    expect(result.status).toBe('escalation_available');
    expect(result.contacts.map(c => c.kind)).toEqual(['network', 'registrar']);
    expect(result.contacts[0].source).toBe('https://registry.example.net/ip/104.16.1.2');
    expect(result.contacts[1].source).toBe('https://registry.example.net/domain/adult-platform.com');
    expect(fetcher.mock.calls.every(([url]) => ['data.iana.org', 'cloudflare-dns.com', 'registry.example.net'].includes(new URL(url).hostname))).toBe(true);
    expect(result.contacts[0].how).toContain('not the website publisher');
  });
  it('uses Cloudflare’s form and does not label it as the origin host', async () => {
    const result = await discoverReportingContact('publicsite.com', provider({ cloudflare: true }));
    expect(result.contacts[0]).toMatchObject({ kind: 'cdn', form: 'https://abuse.cloudflare.com' });
    expect(result.contacts[0].how).toContain('does not identify the origin host');
  });
  it('blocks untrusted registry redirects and private DNS addresses', async () => {
    const fetcher = provider({ redirect: true, privateIp: true });
    const result = await discoverReportingContact('publicsite.com', fetcher);
    expect(result.status).toBe('needs_investigation');
    expect(fetcher.mock.calls.some(([url]) => url.startsWith('https://attacker.example.net') || url.includes('/ip/'))).toBe(false);
  });
  it('returns explicit unresolved coverage instead of inventing abuse@ addresses', async () => {
    const result = await discoverReportingContact('publicsite.com', provider({ empty: true }));
    expect(result.contacts).toEqual([]); expect(result.status).toBe('needs_investigation');
  });
  it('supports adult known-URL forms and an unlisted-site fallback', () => {
    expect(channelForUrl('https://www.pornhub.com/view_video.php?viewkey=example').url).toBe('https://www.pornhub.com/content-removal');
    expect(channelForUrl('https://blog.tumblr.com/post/1').url).toBe('https://www.tumblr.com/abuse');
    expect(channelForUrl('https://unlisted-platform.com/known-post').instructions).toContain('hostname');
  });
});
