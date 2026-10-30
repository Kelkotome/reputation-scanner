import { describe, it, expect, vi } from 'vitest';
import { fetchAllowed, fetchContext, htmlToText, MAX_BYTES } from '../src/fetchText.js';

describe('guarded text fetching', () => {
  it.each(['https://example.com/a.jpg?x=1', 'https://example.com/file.PDF', 'https://example.com/a.mp4'])('rejects media %s', url => {
    expect(fetchAllowed(url)).toEqual({ ok: false, reason: 'media_url' });
  });
  it.each(['http://localhost/a', 'http://127.0.0.1', 'http://10.0.0.1', 'http://192.168.1.2', 'http://172.31.2.3', 'http://169.254.169.254', 'http://[::1]', 'http://[fc00::1]', 'http://[fe80::1]', 'http://[::ffff:192.168.1.2]', 'http://app.localhost'])
  ('rejects local and private addresses %s', url => {
    expect(fetchAllowed(url)).toEqual({ ok: false, reason: 'private_host' });
  });
  it.each(['https://fda.gov', 'https://fca.org.uk', 'https://example.com/article', 'https://[2606:4700:4700::1111]/'])
  ('allows ordinary public hosts %s', url => expect(fetchAllowed(url)).toEqual({ ok: true }));
  it.each(['https://drive.google.com/a', 'https://sub.drive.google.com/a', 'https://sub.dropbox.com/a', 'https://t.me/a', 'https://onlyfans.com/a'])
  ('rejects never-fetch hosts %s', url => expect(fetchAllowed(url).ok).toBe(false));
  it('does not request an initially blocked URL', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchContext('file:///tmp/data', ['anne lee'], { fetchImpl })).toEqual({ state: 'blocked', reason: 'protocol' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('refuses non-HTML without consuming the body', async () => {
    const cancel = vi.fn();
    const getReader = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }), body: { cancel, getReader } });
    expect(await fetchContext('https://example.com/a', ['anne lee'], { fetchImpl })).toEqual({ state: 'blocked', reason: 'not_html' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(getReader).not.toHaveBeenCalled();
  });
  it('does not decode content beyond the byte cap even when delivered in one large chunk', async () => {
    const cancel = vi.fn();
    const read = vi.fn().mockResolvedValue({ done: false, value: new TextEncoder().encode(' '.repeat(MAX_BYTES) + 'Anne Lee private data after cap') });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), body: { getReader: () => ({ read, cancel }) } });
    expect(await fetchContext('https://example.com/a', ['anne lee'], { fetchImpl })).toEqual({ state: 'fetched', text: '' });
    expect(read).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rechecks redirect targets before making a second request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } }));
    expect(await fetchContext('https://example.com/a', ['anne lee'], { fetchImpl })).toEqual({ state: 'blocked', reason: 'private_host' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it('limits redirect loops and resolves relative destinations', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: '/next' } }));
    expect(await fetchContext('https://example.com/a', ['anne lee'], { fetchImpl, maxRedirects: 1 })).toEqual({ state: 'failed', reason: 'too_many_redirects' });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://example.com/next');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('returns only name context, discarding script/style content', async () => {
    const html = '<style>Anne Lee secret style</style><script>Anne Lee secret script</script><p>Anne Lee &amp; a factual complaint.</p>';
    const fetchImpl = vi.fn().mockResolvedValue(new Response(html, { headers: { 'content-type': 'text/html; charset=UTF-8' } }));
    const result = await fetchContext('https://example.com/a', ['anne lee'], { fetchImpl });
    expect(result.state).toBe('fetched');
    expect(result.text).toContain('anne lee');
    expect(result.text).not.toContain('secret');
    expect(htmlToText('<p>A &amp; B</p>')).toBe('A & B');
  });
});
