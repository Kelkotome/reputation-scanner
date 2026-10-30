// Authentication and short-lived pseudonymous quota identities. Never log input.
const encoder = new TextEncoder();
const SESSION_MS = 8 * 60 * 60 * 1000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
export class ApiError extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; this.details = details; }
}
export const fail = (status, message, details) => { throw new ApiError(status, message, details); };
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
export const nextUtc = (now = Date.now()) => Date.parse(`${utcDay(now)}T00:00:00Z`) + 86400000;
const hex = bytes => Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
export const digest = async value => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

function localDevelopment(request, env) {
  return env.LOCAL_DEVELOPMENT === 'true' && LOOPBACK.has(new URL(request.url).hostname.toLowerCase());
}
function requireSecure(request, env) {
  if (new URL(request.url).protocol !== 'https:' && !localDevelopment(request, env)) fail(403, 'Use a secure connection.');
}
function secret(env) {
  if (typeof env.RATE_LIMIT_SECRET !== 'string' || env.RATE_LIMIT_SECRET.length < 32) fail(503, 'Access controls are not configured.');
  return env.RATE_LIMIT_SECRET;
}
export async function keyedHash(env, ...parts) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(JSON.stringify(parts))));
}
// Expands a URL-normalised IPv6 literal ("[2001:db8::1]") into 8 numeric groups.
export function expandV6(address) {
  const value = String(address).replace(/^\[|\]$/g, '');
  const halves = value.split('::');
  if (halves.length > 2) throw new Error('invalid_ipv6');
  const head = halves[0] ? halves[0].split(':') : [], tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) throw new Error('invalid_ipv6');
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  if (groups.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) throw new Error('invalid_ipv6');
  return groups.map(group => parseInt(group, 16));
}
// One subscriber usually controls a whole IPv6 /64, so the daily allowance is
// counted per /64. IPv4-mapped addresses count as the IPv4 address itself.
export function ipv6Bucket(address) {
  const groups = expandV6(address);
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
  }
  return `${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`;
}
export async function dailyIpHash(request, env, now = Date.now()) {
  requireSecure(request, env);
  let ip;
  const host = new URL(request.url).hostname.toLowerCase();
  if (LOOPBACK.has(host)) {
    if (!localDevelopment(request, env)) fail(503, 'Local access controls are not configured.');
    ip = 'local-development'; // Ignore every forwarded header on explicit loopback development.
  } else {
    const raw = request.headers.get('CF-Connecting-IP');
    if (!raw || raw.length > 45 || !/^[0-9a-f:.]+$/i.test(raw)) fail(403, 'A verified client address is required.');
    if (raw.includes(':')) {
      try { ip = ipv6Bucket(new URL(`http://[${raw}]/`).hostname.toLowerCase()); } catch { fail(403, 'A verified client address is required.'); }
    } else {
      const parts = raw.split('.');
      if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) fail(403, 'A verified client address is required.');
      ip = parts.map(Number).join('.');
    }
  }
  return keyedHash(env, 'daily-ip', utcDay(now), ip);
}
function cookieName(request, env) { return localDevelopment(request, env) && new URL(request.url).protocol === 'http:' ? 'ns_operator_dev' : '__Host-ns_operator'; }
function cookieValue(request, env) {
  const name = cookieName(request, env), values = (request.headers.get('Cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
function cookie(request, env, token, maxAge) {
  const secure = localDevelopment(request, env) && new URL(request.url).protocol === 'http:' ? '' : '; Secure';
  return `${cookieName(request, env)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
function configuredOperatorKey(env) {
  return typeof env.OPERATOR_ACCESS_KEY === 'string' && env.OPERATOR_ACCESS_KEY.length >= 32 && env.OPERATOR_ACCESS_KEY.length <= 256 ? env.OPERATOR_ACCESS_KEY : null;
}
const sessionHash = (env, token) => keyedHash(env, 'operator-session', configuredOperatorKey(env), token);
// Admin sessions come from the operator access key. Partner sessions come from
// a Cloudflare Access email sign-in and end as soon as the partner is removed.
// For partners, token_hash is a stable keyed digest of the email, so permits,
// leases and daily allowances follow the partner across sessions.
export async function operatorSession(request, env) {
  const token = cookieValue(request, env);
  if (!token || !configuredOperatorKey(env)) return null;
  requireSecure(request, env);
  const token_hash = await sessionHash(env, token);
  const session = await env.DB.prepare(`SELECT s.token_hash, s.expires_at, s.role, s.partner_email, p.organisation, p.daily_limit
    FROM operator_sessions s LEFT JOIN partners p ON s.role = 'partner' AND p.email = s.partner_email AND p.active = 1
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(token_hash, Date.now()).first();
  if (!session) return null;
  if (session.role !== 'partner') return { token_hash: session.token_hash, expires_at: session.expires_at, role: 'admin' };
  if (session.daily_limit === null || session.daily_limit === undefined) return null;
  return { token_hash: await keyedHash(env, 'partner', session.partner_email), session_hash: session.token_hash, expires_at: session.expires_at,
    role: 'partner', email: session.partner_email, organisation: session.organisation || '', daily_limit: Number(session.daily_limit) };
}
export const isAdmin = session => session?.role === 'admin';
export const isPartner = session => session?.role === 'partner';
export async function createPartnerSession(request, env, email) {
  requireSecure(request, env);
  if (!configuredOperatorKey(env)) fail(503, 'Partner access is not configured.');
  const now = Date.now(), token = hex(crypto.getRandomValues(new Uint8Array(32))), tokenHash = await sessionHash(env, token), expires_at = now + SESSION_MS;
  await env.DB.prepare("INSERT INTO operator_sessions (token_hash, created_at, expires_at, role, partner_email) VALUES (?, ?, ?, 'partner', ?)").bind(tokenHash, now, expires_at, email).run();
  return { expires_at, cookie: cookie(request, env, token, SESSION_MS / 1000) };
}
export async function loginOperator(request, env, accessKey) {
  requireSecure(request, env);
  const configured = configuredOperatorKey(env);
  if (!configured) fail(503, 'Operator access is not configured.');
  if (typeof accessKey !== 'string' || accessKey.length > 256) fail(400, 'Enter a valid access key.');
  const now = Date.now(), day = utcDay(now), ip = await dailyIpHash(request, env, now), bucket = Math.floor(now / 900000);
  await env.DB.prepare(`INSERT INTO operator_login_limits (day, ip_hash, bucket, attempts) VALUES (?, ?, ?, 0)
    ON CONFLICT(day, ip_hash, bucket) DO NOTHING`).bind(day, ip, bucket).run();
  const attempt = await env.DB.prepare(`UPDATE operator_login_limits SET attempts = attempts + 1
    WHERE day = ? AND ip_hash = ? AND bucket = ? AND attempts < 10 RETURNING attempts`).bind(day, ip, bucket).first();
  if (!attempt) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.', { code: 'login_rate_limited', reset_at: (bucket + 1) * 900000 });
  const [actual, expected] = await Promise.all([digest(accessKey), digest(configured)]);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  if (mismatch) fail(401, 'The access key was not accepted.');
  // Deriving the stored hash from the active access key invalidates all existing
  // cookies on key rotation, without ever persisting that key or the cookie.
  const token = hex(crypto.getRandomValues(new Uint8Array(32))), tokenHash = await sessionHash(env, token), expires_at = now + SESSION_MS;
  await env.DB.prepare('INSERT INTO operator_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)').bind(tokenHash, now, expires_at).run();
  return { data: { ok: true, operator: true, expires_at }, cookie: cookie(request, env, token, SESSION_MS / 1000) };
}
export async function logoutOperator(request, env) {
  requireSecure(request, env);
  const token = cookieValue(request, env);
  if (token && configuredOperatorKey(env)) await env.DB.prepare('DELETE FROM operator_sessions WHERE token_hash = ?').bind(await sessionHash(env, token)).run();
  return { data: { ok: true, operator: false }, cookie: cookie(request, env, '', 0) };
}
