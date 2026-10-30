import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import worker from '../src/private-worker.js';
import { validateMessage, gmailMessage, cleanupEmail, runEmailFollowups, FOLLOWUP_DELAY } from '../src/email.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
let db, env, jar;
const root = 'https://scanner.example';
function prepare(sql, args = []) {
  return { bind: (...values) => prepare(sql, values), first: async () => db.prepare(sql).get(...args) || null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }) };
}
async function api(path, body, extra = {}) {
  const response = await worker.fetch(new Request(`${root}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: root, 'CF-Connecting-IP': '203.0.113.12', Cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  for (const line of response.headers.getSetCookie()) { const [k, v] = line.split(';')[0].split('='); jar[k] = v; }
  return response;
}
const message = () => ({ request_id: crypto.randomUUID(), from: 'sender@example.com', to: 'publisher@example.com', subject: 'Removal request — Alex', body: 'Please remove the identified claim.\nThank you, Alex.', confirmed: true });
async function start(provider = 'gmail') {
  const response = await api('/api/email/connect', { provider });
  expect(response.status).toBe(200);
  return new URL((await response.json()).url);
}
function mockAuthorization(provider) {
  fetch.mockResolvedValueOnce(Response.json({ access_token: 'private-access-token', token_type: 'Bearer', expires_in: 3600,
    scope: provider === 'gmail' ? 'https://www.googleapis.com/auth/gmail.send' : 'Mail.Send User.Read' }))
    .mockResolvedValueOnce(Response.json(provider === 'gmail' ? { email: 'sender@example.com', verified_email: true } : { mail: 'sender@example.com' }));
}
async function connect(provider = 'gmail') {
  const target = await start(provider); mockAuthorization(provider);
  const response = await api(`/api/email/callback/${provider}?state=${target.searchParams.get('state')}&code=synthetic-code`);
  expect(response.status).toBe(303);
  expect(response.headers.get('Location')).toBe('/email-connected.html#connected');
  return target;
}
beforeEach(() => {
  db = new DatabaseSync(':memory:'); db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = { DB: { prepare }, RATE_LIMIT_SECRET: 'test-key-for-email-rates-32-characters', EMAIL_APP_ORIGIN: root, EMAIL_TOKEN_KEY: 'a'.repeat(64), GOOGLE_CLIENT_ID: 'google-client', GOOGLE_CLIENT_SECRET: 'google-secret',
    MICROSOFT_CLIENT_ID: 'ms-client', MICROSOFT_CLIENT_SECRET: 'ms-secret' };
  jar = {};
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network call'); }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); db.close(); });

describe('optional connected email', () => {
  it('rejects authorising a different mailbox from the entered sender',async()=>{
    const target=new URL((await (await api('/api/email/connect',{provider:'gmail',expected_email:'entered@example.com'})).json()).url);
    mockAuthorization('gmail');
    const response=await api(`/api/email/callback/gmail?state=${target.searchParams.get('state')}&code=test`);
    expect(response.headers.get('Location')).toBe('/email-connected.html#mismatch');
    expect(db.prepare('SELECT COUNT(*) n FROM email_sessions').get().n).toBe(0);
  });
  it('reports unavailable providers without credentials and never shares secrets in status', async () => {
    delete env.GOOGLE_CLIENT_SECRET; delete env.MICROSOFT_CLIENT_ID;
    expect(await (await api('/api/email/status')).json()).toEqual({ providers: { gmail: false, outlook: false }, account: null });
    expect((await api('/api/email/connect', { provider: 'gmail' })).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('requires a pinned origin, JSON and same-origin POST, including missing Origin', async () => {
    expect((await api('/api/email/connect', { provider: 'gmail' }, { Origin: 'https://evil.example' })).status).toBe(403);
    const missing = await worker.fetch(new Request(`${root}/api/email/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"provider":"gmail"}' }), env);
    expect(missing.status).toBe(403);
    expect((await api('/api/email/connect', { provider: 'gmail' }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    env.EMAIL_APP_ORIGIN = 'https://other.example';
    expect((await api('/api/email/connect', { provider: 'gmail' })).status).toBe(403);
  });
  it.each(['gmail', 'outlook'])('connects %s with state, PKCE and an encrypted short-lived server session', async provider => {
    const target = await connect(provider);
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('scope')).not.toMatch(/offline|Mail.Read|gmail.readonly/);
    expect(target.href).not.toContain('secret');
    const exchange = new URLSearchParams(fetch.mock.calls[0][1].body);
    expect(exchange.get('code_verifier')).toHaveLength(64);
    expect(exchange.get('client_secret')).toBe(provider === 'gmail' ? 'google-secret' : 'ms-secret');
    const row = db.prepare('SELECT * FROM email_sessions').get();
    expect(row.sealed).not.toContain('private-access-token'); expect(row.sealed).not.toContain('sender@example.com');
    expect(row.expires_at - Date.now()).toBeLessThanOrEqual(3600000);
    const status = await (await api('/api/email/status')).json();
    expect(status.account).toMatchObject({ provider, email: 'sender@example.com' });
    expect(JSON.stringify(status)).not.toContain('private-access-token');
    expect(db.prepare('SELECT COUNT(*) AS n FROM email_oauth').get().n).toBe(0);
  });
  it('rejects missing binding, cross-provider state and callback replay without exchanging a code', async () => {
    const target = await start(); const state = target.searchParams.get('state');
    expect((await api(`/api/email/callback/outlook?state=${state}&code=x`)).headers.get('Location')).toContain('failed');
    expect(fetch).not.toHaveBeenCalled();
    const next = await connect();
    const before = fetch.mock.calls.length;
    expect((await api(`/api/email/callback/gmail?state=${next.searchParams.get('state')}&code=x`)).headers.get('Location')).toContain('failed');
    expect(fetch.mock.calls.length).toBe(before);
  });
  it('rejects expired states and incomplete consent', async () => {
    let target = await start(); db.prepare('UPDATE email_oauth SET expires_at = 0').run();
    expect((await api(`/api/email/callback/gmail?state=${target.searchParams.get('state')}&code=x`)).headers.get('Location')).toContain('failed');
    expect(fetch).not.toHaveBeenCalled();
    target = await start();
    fetch.mockResolvedValueOnce(Response.json({ access_token: 'private', token_type: 'Bearer', scope: 'email', expires_in: 3600 }));
    expect((await api(`/api/email/callback/gmail?state=${target.searchParams.get('state')}&code=x`)).headers.get('Location')).toContain('failed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM email_sessions').get().n).toBe(0);
  });
  it.each(['gmail', 'outlook'])('sends through %s only after confirmation and deduplicates retries', async provider => {
    await connect(provider); fetch.mockClear();
    fetch.mockResolvedValueOnce(new Response(provider === 'gmail' ? '{"id":"provider-message"}' : null, { status: provider === 'gmail' ? 200 : 202 }));
    const body = message();
    expect(await (await api('/api/email/send', body)).json()).toEqual({ status: 'accepted' });
    expect(await (await api('/api/email/send', body)).json()).toEqual({ status: 'accepted', duplicate: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(options.redirect).toBe('manual');
    expect(options.headers.Authorization).toBe('Bearer private-access-token');
    if (provider === 'outlook') {
      expect(url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
      expect(JSON.parse(options.body).message.toRecipients[0].emailAddress.address).toBe(body.to);
    } else expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    expect((await api('/api/email/send', { ...body, to: 'other@example.com' })).status).toBe(409);
    expect(JSON.stringify(db.prepare('SELECT * FROM email_sends').get())).not.toContain(body.body);
  });
  it('never retries an ambiguous timeout and reports provider rejection without claiming success', async () => {
    await connect(); fetch.mockClear(); fetch.mockRejectedValueOnce(new Error('timeout'));
    const body = message();
    expect(await (await api('/api/email/send', body)).json()).toMatchObject({ status: 'unknown' });
    expect(await (await api('/api/email/send', body)).json()).toMatchObject({ status: 'unknown', duplicate: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(new Response('', { status: 403 }));
    expect(await (await api('/api/email/send', message())).json()).toEqual({ status: 'rejected' });
  });
  it('disconnects and expires server access', async () => {
    await connect(); fetch.mockClear();
    await api('/api/email/disconnect', {});
    expect((await (await api('/api/email/status')).json()).account).toBeNull();
    expect((await api('/api/email/send', message())).status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
    await connect(); db.prepare('UPDATE email_sessions SET expires_at = 0').run();
    await cleanupEmail(env);
    expect(db.prepare('SELECT COUNT(*) AS n FROM email_sessions').get().n).toBe(0);
  });
  it('rejects a changed sending account and caps connection attempts', async () => {
    await connect(); fetch.mockClear();
    expect((await api('/api/email/send', { ...message(), from: 'different@example.com' })).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++) await api('/api/email/connect', { provider: 'gmail' });
    expect((await api('/api/email/connect', { provider: 'gmail' })).status).toBe(429);
  });
  it('blocks unreviewed drafts, placeholders, multiple recipients and header injection', () => {
    for (const change of [{ confirmed: false }, { to: 'a@example.com,b@example.com' }, { subject: 'Test\r\nBcc: someone@example.com' }, { body: 'Please remove [Describe the issue].' }, { to: 'x@example.com\r\nBcc:x@example.com' }]) {
      expect(() => validateMessage({ ...message(), ...change })).toThrow();
    }
    const raw = gmailMessage({ email: 'sender@example.com' }, message());
    const mime = Buffer.from(raw, 'base64url').toString();
    expect(mime).toContain('Subject: =?UTF-8?B?');
    expect(mime).toContain('Content-Transfer-Encoding: base64');
  });
});

async function offline(provider = 'gmail') {
  const target = new URL((await (await api('/api/email/connect', { provider, offline: true })).json()).url);
  fetch.mockResolvedValueOnce(Response.json({ access_token:'access', refresh_token:'private-refresh', token_type:'Bearer', expires_in:3600, scope: provider === 'gmail' ? 'https://www.googleapis.com/auth/gmail.send' : 'Mail.Send' }))
    .mockResolvedValueOnce(Response.json({ email:'sender@example.com', verified_email:true, mail:'sender@example.com' }));
  expect((await api(`/api/email/callback/${provider}?state=${target.searchParams.get('state')}&code=test`)).headers.get('Location')).toContain('#connected');
  fetch.mockClear(); return target;
}
async function queue() {
  const body = { ...message(), followup: { subject:'Follow-up on removal', body:'Please update me on the earlier removal request.' } };
  fetch.mockResolvedValueOnce(new Response('{}', {status:200}));
  const response = await api('/api/email/send', body); expect(response.status).toBe(200);
  return { body, result:await response.json() };
}
describe('approved 14-day follow-ups', () => {
  it.each(['gmail','outlook'])('uses opted-in offline permission and encrypted retention for %s', async provider => {
    const target = await offline(provider);
    expect(provider === 'gmail' ? target.searchParams.get('access_type') : target.searchParams.get('scope')).toContain(provider === 'gmail' ? 'offline' : 'offline_access');
    const {body,result} = await queue();
    expect(result.followup.due_at - result.followup.first_sent_at).toBe(FOLLOWUP_DELAY);
    expect(JSON.stringify(db.prepare('SELECT * FROM email_followups').get())).not.toContain(body.followup.body);
    expect(JSON.stringify(db.prepare('SELECT * FROM email_sessions').get())).not.toContain('private-refresh');
    expect((await (await api('/api/email/followups')).json()).jobs).toHaveLength(1);
  });
  it('sends once at the boundary, refreshes tokens, and never sends earlier', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2028-02-20T12:00:00Z')); await offline();
    const {result} = await queue(); fetch.mockClear();
    vi.setSystemTime(result.followup.due_at - 1); await runEmailFollowups(env); expect(fetch).not.toHaveBeenCalled();
    vi.setSystemTime(result.followup.due_at);
    fetch.mockResolvedValueOnce(Response.json({ access_token:'renewed', refresh_token:'rotated', token_type:'Bearer', expires_in:3600 })).mockResolvedValueOnce(new Response('{}'));
    await Promise.all([runEmailFollowups(env),runEmailFollowups(env)]); await runEmailFollowups(env);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer renewed');
    expect(db.prepare('SELECT status, sealed FROM email_followups').get()).toMatchObject({status:'accepted',sealed:''});
  });
  it.each(['cancelled','replied','closed'])('stops a queued follow-up when %s', async reason => {
    await offline(); const {body,result} = await queue(); fetch.mockClear();
    expect((await api('/api/email/cancel-followup', {request_id:body.request_id,reason})).status).toBe(200);
    vi.useFakeTimers(); vi.setSystemTime(result.followup.due_at); await runEmailFollowups(env); expect(fetch).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status, sealed FROM email_followups').get()).toMatchObject({status:reason,sealed:''});
  });
  it('holds ambiguous follow-ups without retry and flags revoked access', async () => {
    await offline(); const {result} = await queue();
    vi.useFakeTimers(); vi.setSystemTime(result.followup.due_at);
    fetch.mockClear(); fetch.mockResolvedValueOnce(Response.json({access_token:'new',token_type:'Bearer',expires_in:3600})).mockRejectedValueOnce(new Error('timeout'));
    await runEmailFollowups(env); await runEmailFollowups(env);
    expect(fetch).toHaveBeenCalledTimes(2); expect(db.prepare('SELECT status FROM email_followups').get().status).toBe('unknown');
  });
  it('does not send after refresh failure, disconnect, or from another owner', async () => {
    await offline(); const {body,result} = await queue(); const originalJar = {...jar}; jar = {};
    expect((await (await api('/api/email/followups')).json()).jobs).toEqual([]);
    expect((await api('/api/email/cancel-followup',{request_id:body.request_id,reason:'closed'})).status).toBe(401); jar = originalJar;
    vi.useFakeTimers(); vi.setSystemTime(result.followup.due_at);
    fetch.mockClear(); fetch.mockResolvedValueOnce(new Response('{}',{status:400})); await runEmailFollowups(env);
    expect(fetch).toHaveBeenCalledTimes(1); expect(db.prepare('SELECT status FROM email_followups').get().status).toBe('needs_attention');
    await api('/api/email/disconnect',{}); expect(db.prepare('SELECT COUNT(*) n FROM email_sessions').get().n).toBe(0);
  });
  it('does not queue without offline access or when first delivery is rejected', async () => {
    await connect(); const body = {...message(),followup:{subject:'Reminder',body:'An approved reminder'}};
    expect((await api('/api/email/send',body)).status).toBe(409);
    await offline(); fetch.mockResolvedValueOnce(new Response('',{status:403}));
    expect((await (await api('/api/email/send',body)).json()).followup.status).toBe('rejected');
    expect(db.prepare('SELECT sealed FROM email_followups').get().sealed).toBe('');
  });
  it('cancels pending jobs on disconnect and refuses unexpectedly late sending', async () => {
    await offline(); await queue();
    await api('/api/email/disconnect',{});
    expect(db.prepare('SELECT status,sealed FROM email_followups').get()).toMatchObject({status:'cancelled',sealed:''});
    await offline(); const {result}=await queue();fetch.mockClear();
    vi.useFakeTimers();vi.setSystemTime(result.followup.due_at+3*86400000);await runEmailFollowups(env);
    expect(fetch).not.toHaveBeenCalled();
    expect(db.prepare("SELECT status FROM email_followups WHERE status != 'cancelled'").get().status).toBe('needs_attention');
  });
  it('recovers and cancels a mailbox queue after the browser cookie is lost', async () => {
    await offline(); const {body}=await queue();
    jar={};
    expect((await (await api('/api/email/followups')).json()).jobs).toEqual([]);
    await offline();
    const result=await (await api('/api/email/followups')).json();
    expect(result.jobs).toEqual([expect.objectContaining({request_id:body.request_id,status:'cancelled'})]);
    expect(db.prepare('SELECT COUNT(*) n FROM email_sessions').get().n).toBe(1);
  });
  it('does not expose another mailbox history after reauthentication', async () => {
    await offline();await queue();jar={};
    const target=await start();
    fetch.mockResolvedValueOnce(Response.json({access_token:'other',token_type:'Bearer',expires_in:3600,scope:'https://www.googleapis.com/auth/gmail.send'})).mockResolvedValueOnce(Response.json({email:'different@example.com',verified_email:true}));
    await api(`/api/email/callback/gmail?state=${target.searchParams.get('state')}&code=other`);
    expect((await (await api('/api/email/followups')).json()).jobs).toEqual([]);
    expect(db.prepare('SELECT status FROM email_followups').get().status).toBe('queued');
  });
  it('does not promise automatic scheduling in a local preview', async()=>{
    await offline(); env.LOCAL_DEVELOPMENT='true';
    const response=await api('/api/email/send',{...message(),followup:{subject:'Reminder',body:'Please review'}});
    expect(response.status).toBe(409); expect(fetch).not.toHaveBeenCalled();
    expect((await (await api('/api/email/status')).json()).account.followups_enabled).toBe(false);
  });
});
