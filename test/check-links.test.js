import { it, expect, vi } from 'vitest';
import { checkLink } from '../scripts/check-links.mjs';

it('checks reachability without reading the response body', async () => {
  const response = new Response('unread body');
  const read = vi.spyOn(response, 'text');
  expect((await checkLink('https://site.com', async () => response)).ok).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(response.body.locked).toBe(false);
});
it('accepts only an unexpired verified status and challenge header combination', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-24T00:00:00Z'));
  try {
    const challenge = () => new Response(null, { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    expect((await checkLink('https://help.x.com/en/forms', async () => challenge())).restricted).toBe(true);
    expect((await checkLink('https://help.x.com/en/forms', async () => new Response(null, { status: 500 }))).ok).toBe(false);
    expect((await checkLink('https://help.x.com/en/forms', async () => new Response(null, { status: 403 }))).ok).toBe(false);
    vi.setSystemTime(new Date('2026-12-25T00:00:00Z'));
    expect((await checkLink('https://help.x.com/en/forms', async () => challenge())).ok).toBe(false);
  } finally { vi.useRealTimers(); }
});
it('never suppresses an unknown domain restriction or DNS failure', async () => {
  expect((await checkLink('https://other.com', async () => new Response(null, { status: 403 }))).ok).toBe(false);
  const error = new Error('failed'); error.cause = { code: 'ENOTFOUND' };
  expect(await checkLink('https://help.x.com/en/forms', async () => { throw error; })).toMatchObject({ ok: false, status: null, reason: 'ENOTFOUND' });
});
