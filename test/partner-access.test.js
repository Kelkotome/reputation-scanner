import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/private-worker.js';
import { verifyAccessJwt, clearAccessKeyCache } from '../src/access-jwt.js';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');

const team = 'synthetic-team.cloudflareaccess.com';
const partnerAud = 'a'.repeat(64), adminAud = 'b'.repeat(64);
const accessKey = 'synthetic-operator-access-key-32-chars-only';
let sqlite, env, keys, jwk, otherKeys;
const enc = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
async function token(claims = {}, { kid = 'k1', key = keys.privateKey, alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${enc({ alg, kid, typ: 'JWT' })}.${enc({ aud: [partnerAud], iss: `https://${team}`, email: 'Case@Partner.example', iat: now, nbf: now, exp: now + 600, ...claims })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(body));
  return `${body}.${Buffer.from(signature).toString('base64url')}`;
}
function prepare(sql, args = []) {
  return { bind: (...values) => prepare(sql, values),
    first: async () => sqlite.prepare(sql).get(...args) || null,
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }) };
}
async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const response = await worker.fetch(new Request(`https://scanner.example${path}`, { method, redirect: 'manual',
    headers: { 'CF-Connecting-IP': '203.0.113.9', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env);
  const type = response.headers.get('content-type') || '';
  return { status: response.status, headers: response.headers, data: type.includes('json') ? await response.json() : null };
}
const accessHeader = async claims => ({ 'Cf-Access-Jwt-Assertion': await token(claims) });
const adminHeader = () => accessHeader({ aud: [adminAud], email: 'hello@123reputationmanagement.org' });
async function adminCookie() {
  const response = await call('/api/operator/login', { method: 'POST', body: { access_key: accessKey }, headers: await adminHeader() });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie').split(';')[0];
}
async function partnerCookie(claims) {
  const response = await call('/api/partner/login', { headers: await accessHeader(claims) });
  expect(response.status).toBe(302); expect(response.headers.get('location')).toBe('/');
  return response.headers.get('set-cookie').split(';')[0];
}
const addPartner = (cookie, { headers, ...body }) => call('/api/operator/partners', { method: 'POST', body, headers: { Cookie: cookie, ...headers } });

beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  otherKeys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' };
});
beforeEach(() => {
  clearAccessKeyCache();
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  env = { DB: { prepare }, SERP_PROVIDER: 'serpapi', SERP_API_KEY: 'synthetic-provider-key', ALLOW_SEARCH_RELAY: 'true',
    OPERATOR_ACCESS_KEY: accessKey, RATE_LIMIT_SECRET: 'synthetic-rate-limit-secret-32-chars-only', MAX_QUERIES: '12',
    ACCESS_TEAM_DOMAIN: team, ACCESS_PARTNER_AUD: partnerAud, ACCESS_ADMIN_AUD: adminAud, ADMIN_EMAILS: 'hello@123reputationmanagement.org',
    ASSETS: { fetch: vi.fn() } };
  vi.stubGlobal('fetch', vi.fn(async url => String(url) === `https://${team}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : new Response('unexpected', { status: 500 })));
});
afterEach(() => { vi.unstubAllGlobals(); sqlite.close(); });

describe('Cloudflare Access token verification', () => {
  const verify = headers => verifyAccessJwt(new Request('https://scanner.example/', { headers }), env, partnerAud);
  it('accepts a valid signed token and lower-cases the email', async () => {
    expect(await verify(await accessHeader())).toEqual({ email: 'case@partner.example' });
  });
  it('rejects wrong audience, issuer, expiry, signature, algorithm, key id and missing configuration', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verify(await accessHeader({ aud: [adminAud] }))).toBeNull();
    expect(await verify(await accessHeader({ iss: 'https://evil.cloudflareaccess.com' }))).toBeNull();
    expect(await verify(await accessHeader({ exp: now - 3600 }))).toBeNull();
    expect(await verify(await accessHeader({ nbf: now + 3600 }))).toBeNull();
    expect(await verify({ 'Cf-Access-Jwt-Assertion': await token({}, { key: otherKeys.privateKey }) })).toBeNull();
    expect(await verify({ 'Cf-Access-Jwt-Assertion': await token({}, { kid: 'unknown' }) })).toBeNull();
    const unsigned = `${enc({ alg: 'none', kid: 'k1' })}.${enc({ aud: [partnerAud], iss: `https://${team}`, email: 'x@y.example', exp: now + 600 })}.`;
    expect(await verify({ 'Cf-Access-Jwt-Assertion': unsigned })).toBeNull();
    expect(await verify({ 'Cf-Authenticated-User-Email': 'case@partner.example' })).toBeNull();
    env.ACCESS_TEAM_DOMAIN = 'attacker.example';
    expect(await verify(await accessHeader())).toBeNull();
  });
});

describe('partner sign-in and allowance', () => {
  it('signs in only registered partners and treats them as signed in without admin rights', async () => {
    expect((await call('/api/partner/login')).headers.get('location')).toBe('/partner.html#unavailable');
    expect((await call('/api/partner/login', { headers: await accessHeader() })).headers.get('location')).toBe('/partner.html#not-registered');
    const admin = await adminCookie();
    expect((await addPartner(admin, { email: ' Case@Partner.example ', organisation: 'Example Legal Aid', headers: await adminHeader() })).status).toBe(200);
    const cookie = await partnerCookie();
    const config = (await call('/api/config', { headers: { Cookie: cookie } })).data;
    expect(config).toMatchObject({ operator: false, bot_check_required: false, max_queries: 12,
      partner: { email: 'case@partner.example', organisation: 'Example Legal Aid', daily_limit: 50, remaining_scans: 50 } });
    expect((await call('/api/operator/session', { headers: { Cookie: cookie } })).data).toMatchObject({ operator: false, partner: { email: 'case@partner.example' } });
    expect((await call('/api/operator/usage', { headers: { Cookie: cookie, ...await adminHeader() } })).status).toBe(401);
    expect((await call('/api/operator/partners', { headers: { Cookie: cookie, ...await adminHeader() } })).status).toBe(401);
    expect(sqlite.prepare('SELECT last_login_at FROM partners').get().last_login_at).toEqual(expect.any(Number));
  });
  it('counts scan starts per partner email across sessions and stops at the daily limit', async () => {
    const admin = await adminCookie();
    await addPartner(admin, { email: 'case@partner.example', organisation: 'Example', daily_limit: 2, headers: await adminHeader() });
    const first = await partnerCookie(), second = await partnerCookie();
    const id = crypto.randomUUID();
    const a = await call('/api/search-session', { method: 'POST', body: { request_id: id }, headers: { Cookie: first } });
    expect(a.status).toBe(200); expect(a.data.remaining_scans).toBe(1); expect(a.data.max_requests).toBe(26);
    expect((await call('/api/search-session', { method: 'POST', body: { request_id: id }, headers: { Cookie: first } })).data.remaining_scans).toBe(1);
    expect((await call('/api/search-session', { method: 'POST', body: { request_id: crypto.randomUUID() }, headers: { Cookie: second } })).data.remaining_scans).toBe(0);
    const third = await call('/api/search-session', { method: 'POST', body: { request_id: crypto.randomUUID() }, headers: { Cookie: first } });
    expect(third.status).toBe(429); expect(third.data.code).toBe('scan_limit_reached');
    expect(sqlite.prepare('SELECT scans FROM partner_usage').get().scans).toBe(2);
    const listed = (await call('/api/operator/partners', { headers: { Cookie: admin, ...await adminHeader() } })).data;
    expect(listed.partners[0]).toMatchObject({ email: 'case@partner.example', scans_today: 2, scans_30_days: 2, daily_limit: 2 });
    expect(listed.default_daily_limit).toBe(50);
  });
  it('ends partner sessions as soon as the partner is removed', async () => {
    const admin = await adminCookie();
    await addPartner(admin, { email: 'case@partner.example', organisation: 'Example', headers: await adminHeader() });
    const cookie = await partnerCookie();
    expect((await call('/api/operator/partners/remove', { method: 'POST', body: { email: 'CASE@partner.example' }, headers: { Cookie: admin, ...await adminHeader() } })).status).toBe(200);
    expect((await call('/api/config', { headers: { Cookie: cookie } })).data).toMatchObject({ operator: false, partner: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM operator_sessions WHERE role = 'partner'").get().n).toBe(0);
    expect((await call('/api/partner/login', { headers: await accessHeader() })).headers.get('location')).toBe('/partner.html#not-registered');
  });
});

describe('admin routes behind Cloudflare Access', () => {
  it('requires the admin Access sign-in for operator login and partner management', async () => {
    expect((await call('/api/operator/login', { method: 'POST', body: { access_key: accessKey } })).status).toBe(403);
    expect((await call('/api/operator/login', { method: 'POST', body: { access_key: accessKey }, headers: await accessHeader({ aud: [adminAud], email: 'someone@else.example' }) })).status).toBe(403);
    expect((await call('/api/operator/login', { method: 'POST', body: { access_key: accessKey }, headers: await accessHeader() })).status).toBe(403);
    const admin = await adminCookie();
    expect((await call('/api/operator/usage', { headers: { Cookie: admin } })).status).toBe(403);
    expect((await call('/api/operator/usage', { headers: { Cookie: admin, ...await adminHeader() } })).status).toBe(200);
  });
  it('validates partner details', async () => {
    const admin = await adminCookie(), headers = { Cookie: admin, ...await adminHeader() };
    for (const body of [{ email: 'not-an-email', organisation: 'X' }, { email: 'a@b.example', organisation: 'X', daily_limit: 0 },
      { email: 'a@b.example', organisation: 'X', daily_limit: 501 }, { email: 'a@b.example', organisation: 'x'.repeat(121) }, { email: 'a@b.example' }]) {
      expect((await call('/api/operator/partners', { method: 'POST', body, headers })).status).toBe(400);
    }
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM partners').get().n).toBe(0);
  });
  it('keeps existing operator behaviour when Access is not configured', async () => {
    delete env.ACCESS_TEAM_DOMAIN;
    const response = await call('/api/operator/login', { method: 'POST', body: { access_key: accessKey } });
    expect(response.status).toBe(200);
    expect((await call('/api/partner/login', { headers: await accessHeader() })).headers.get('location')).toBe('/partner.html#unavailable');
  });
});

describe('migration', () => {
  it('upgrades a database created from the previous schema', () => {
    const old = new DatabaseSync(':memory:');
    old.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
      .replace(/,\n  role TEXT NOT NULL DEFAULT 'admin' CHECK\(role IN \('admin', 'partner'\)\),\n  partner_email TEXT\n/, '\n')
      .replace(/-- Partner organisations[\s\S]*$/, ''));
    old.prepare('INSERT INTO operator_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run('x', 1, 2);
    old.exec(readFileSync(new URL('../migrations/0002_partners.sql', import.meta.url), 'utf8'));
    expect(old.prepare('SELECT role, partner_email FROM operator_sessions').get()).toEqual({ role: 'admin', partner_email: null });
    expect(old.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('partners', 'partner_usage')").get().n).toBe(2);
    old.close();
  });
});
