import { dailyIpHash, fail } from './operator-access.js';

export const abuseEnabled = env => env.ABUSE_PROTECTION_ENABLED === 'true';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_VERIFY_BYTES = 16 * 1024;
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
function botSetup(request, env) {
  const hostname = new URL(request.url).hostname.toLowerCase();
  const localBypass = env.LOCAL_DEVELOPMENT === 'true' && LOOPBACK.has(hostname) && env.TURNSTILE_ENABLED === 'false';
  const site = typeof env.TURNSTILE_SITE_KEY === 'string' ? env.TURNSTILE_SITE_KEY.trim() : '';
  const secret = typeof env.TURNSTILE_SECRET_KEY === 'string' ? env.TURNSTILE_SECRET_KEY.trim() : '';
  const expected = typeof env.TURNSTILE_HOSTNAME === 'string' ? env.TURNSTILE_HOSTNAME.trim().toLowerCase() : '';
  const configured = env.TURNSTILE_ENABLED === 'true' && Boolean(site && secret && expected) && expected === hostname;
  return { configured, localBypass, site, secret, hostname: expected };
}
export function abuseConfig(request, env, operator) {
  const setup = botSetup(request, env), enabled = abuseEnabled(env);
  return { abuse_protection_enabled: enabled, bot_check_required: enabled && !operator && !setup.localBypass,
    bot_check_configured: setup.configured || setup.localBypass,
    turnstile_site_key: setup.configured ? setup.site : null, scan_cooldown_seconds: enabled ? 60 : 0 };
}
const limited = (code, message, until) => fail(429, message, { code, reset_at: until, retry_after_seconds: Math.max(1, Math.ceil((until - Date.now()) / 1000)) });
export async function cleanupAbuseMetadata(env, now = Date.now()) {
  await env.DB.prepare('DELETE FROM public_abuse_counters WHERE expires_at <= ?').bind(now).run();
  await env.DB.prepare('DELETE FROM relay_leases WHERE expires_at <= ?').bind(now).run();
}
async function throttle(env, owner, scope, limit, interval, code = 'request_rate_limited') {
  const now = Date.now(), bucket = Math.floor(now / interval), until = (bucket + 1) * interval;
  const allowed = await env.DB.prepare(`INSERT INTO public_abuse_counters (owner_hash, scope, bucket, requests, expires_at)
    VALUES (?, ?, ?, 1, ?) ON CONFLICT(owner_hash, scope, bucket) DO UPDATE SET requests = requests + 1
    WHERE requests < ? RETURNING requests`).bind(owner, scope, bucket, until, limit).first();
  if (!allowed) limited(code, code === 'assistance_limit' ? 'You have reached the hourly assistance limit. Please try again later.' : 'Too many requests. Please wait and try again.', until);
}
async function verificationJson(response) {
  const length = response.headers.get('Content-Length');
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') || '')
    || (length && (!/^\d+$/.test(length) || Number(length) > MAX_VERIFY_BYTES)) || !response.body) {
    await response.body?.cancel(); throw new Error('verification_unavailable');
  }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_VERIFY_BYTES) { await reader.cancel(); throw new Error('verification_unavailable'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export async function verifyChallenge(request, env, operator, token, action, fetchImpl = fetch) {
  if (!abuseEnabled(env) || operator) return;
  const setup = botSetup(request, env);
  if (setup.localBypass) return;
  if (!setup.configured) fail(503, 'Bot verification is not configured. Please try again later.', { code: 'bot_check_unavailable' });
  if (typeof token !== 'string' || !token || token.length > 2048 || /[\u0000-\u0020\u007f]/.test(token)) fail(403, 'Complete the bot verification before continuing.', { code: 'bot_check_required' });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  let result;
  try {
    // Siteverify receives only its secret and opaque challenge response. No IP,
    // query, identity, report, assistance message or application record is sent.
    const response = await fetchImpl(VERIFY_URL, { method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ secret: setup.secret, response: token }), signal: controller.signal });
    result = await verificationJson(response);
  } catch { fail(503, 'Bot verification is temporarily unavailable. Please try again.', { code: 'bot_check_unavailable' }); }
  finally { clearTimeout(timer); }
  if (result?.success !== true || result.hostname !== setup.hostname || result.action !== action) fail(403, 'Bot verification was not accepted. Please try again.', { code: 'bot_check_failed' });
}
export async function protectPermitStart(request, env, operator, token) {
  if (!abuseEnabled(env)) return;
  const owner = operator ? operator.token_hash : await dailyIpHash(request, env);
  await cleanupAbuseMetadata(env);
  await throttle(env, owner, operator ? 'operator_scan_start' : 'scan_start', operator ? 30 : 10, 60000);
  // This preflight avoids charging an already-busy start. It cannot reserve
  // future capacity; each relay still acquires its own authoritative lease.
  const now = Date.now();
  const capacity = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM relay_leases WHERE expires_at > ?) AS total,
    (SELECT COUNT(*) FROM relay_leases WHERE owner_hash = ? AND expires_at > ?) AS owned`)
    .bind(now, owner, now).first();
  if (capacity.total >= 6 || capacity.owned >= (operator ? 4 : 2)) limited('search_busy', 'Search is busy. Please wait a moment and retry.', now + 5000);
  await verifyChallenge(request, env, operator, token, 'scan_start');
}
export async function protectAssistance(request, env, operator, token) {
  if (!abuseEnabled(env)) return;
  const owner = await dailyIpHash(request, env);
  await cleanupAbuseMetadata(env);
  await throttle(env, owner, 'assistance_burst', 5, 60000);
  // Avoid spending another single-use challenge after the hourly cap is full.
  const bucket = Math.floor(Date.now() / 3600000);
  const previous = await env.DB.prepare("SELECT requests FROM public_abuse_counters WHERE owner_hash = ? AND scope = 'assistance_hour' AND bucket = ?").bind(owner, bucket).first();
  if (previous?.requests >= 3) limited('assistance_limit', 'You have reached the hourly assistance limit. Please try again later.', (bucket + 1) * 3600000);
  await verifyChallenge(request, env, operator, token, 'assistance');
  await throttle(env, owner, 'assistance_hour', 3, 3600000, 'assistance_limit');
}
export async function acquireRelayLease(request, env, operator) {
  if (!abuseEnabled(env)) return null;
  const owner = operator ? operator.token_hash : await dailyIpHash(request, env);
  await cleanupAbuseMetadata(env);
  if (!operator) await throttle(env, owner, 'relay', 30, 60000);
  const now = Date.now(), leaseId = crypto.randomUUID(), expires = now + 30000, limit = operator ? 4 : 2;
  const lease = await env.DB.prepare(`INSERT INTO relay_leases (id, owner_hash, expires_at)
    SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM relay_leases WHERE expires_at > ?) < 6
      AND (SELECT COUNT(*) FROM relay_leases WHERE owner_hash = ? AND expires_at > ?) < ? RETURNING id`)
    .bind(leaseId, owner, expires, now, owner, now, limit).first();
  if (!lease) limited('search_busy', 'Search is busy. Please wait a moment and retry.', now + 5000);
  return { id: leaseId, expires_at: expires };
}
export async function releaseRelayLease(env, lease) {
  if (lease) await env.DB.prepare('DELETE FROM relay_leases WHERE id = ?').bind(lease.id).run();
}
