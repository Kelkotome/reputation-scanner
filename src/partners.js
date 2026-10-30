// Partner accounts for NGOs and law/PR firms. Cloudflare Access proves the
// email address with a one-time PIN; this table decides who is a partner.
import { fail, utcDay, nextUtc, createPartnerSession } from './operator-access.js';
import { verifyAccessJwt } from './access-jwt.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_DAILY_LIMIT = 50;

export function partnerDefaultLimit(env) {
  const n = Number(env.PARTNER_DAILY_LIMIT ?? DEFAULT_DAILY_LIMIT);
  return Number.isSafeInteger(n) && n >= 1 && n <= 500 ? n : DEFAULT_DAILY_LIMIT;
}
function normaliseEmail(value) {
  if (typeof value !== 'string' || value.length > 254) fail(400, 'Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (!EMAIL.test(email) || /[\u0000-\u001f\u007f]/.test(email)) fail(400, 'Enter a valid email address.');
  return email;
}
// Top-level navigation from the Access sign-in page; answers with redirects only.
const redirect = location => new Response(null, { status: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
export async function partnerLogin(request, env, fetchImpl = fetch) {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  const identity = await verifyAccessJwt(request, env, env.ACCESS_PARTNER_AUD, fetchImpl);
  if (!identity) return redirect('/partner.html#unavailable');
  const partner = await env.DB.prepare('SELECT email FROM partners WHERE email = ? AND active = 1').bind(identity.email).first();
  if (!partner) return redirect('/partner.html#not-registered');
  const session = await createPartnerSession(request, env, partner.email);
  await env.DB.prepare('UPDATE partners SET last_login_at = ? WHERE email = ?').bind(Date.now(), partner.email).run();
  return new Response(null, { status: 302, headers: { Location: '/', 'Set-Cookie': session.cookie, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
/** Admin pages additionally require the Cloudflare Access admin sign-in when Access is configured. */
export async function requireAdminAccess(request, env, fetchImpl = fetch) {
  if (!env.ACCESS_TEAM_DOMAIN) return;
  const identity = await verifyAccessJwt(request, env, env.ACCESS_ADMIN_AUD, fetchImpl);
  const admins = String(env.ADMIN_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!identity || !admins.includes(identity.email)) fail(403, 'Admin sign-in through Cloudflare Access is required.');
}
export async function partnerRemaining(env, partner, now = Date.now()) {
  const row = await env.DB.prepare('SELECT scans FROM partner_usage WHERE day = ? AND email = ?').bind(utcDay(now), partner.email).first();
  return Math.max(0, partner.daily_limit - (row?.scans || 0));
}
/** Atomically uses one of the partner's daily scan starts. */
export async function reservePartnerScan(env, partner, now = Date.now()) {
  const day = utcDay(now);
  await env.DB.prepare('INSERT INTO partner_usage (day, email, scans) VALUES (?, ?, 0) ON CONFLICT(day, email) DO NOTHING').bind(day, partner.email).run();
  const used = await env.DB.prepare('UPDATE partner_usage SET scans = scans + 1 WHERE day = ? AND email = ? AND scans < ? RETURNING scans').bind(day, partner.email, partner.daily_limit).first();
  if (!used) fail(429, `You have used today’s ${partner.daily_limit} partner scans. Try again after midnight UTC.`, { code: 'scan_limit_reached', reset_at: nextUtc(now) });
  return Math.max(0, partner.daily_limit - used.scans);
}
export async function listPartners(env, now = Date.now()) {
  const { results = [] } = await env.DB.prepare(`SELECT p.email, p.organisation, p.daily_limit, p.created_at, p.last_login_at,
      COALESCE((SELECT scans FROM partner_usage u WHERE u.email = p.email AND u.day = ?), 0) AS scans_today,
      COALESCE((SELECT SUM(scans) FROM partner_usage u WHERE u.email = p.email AND u.day >= ?), 0) AS scans_30_days
    FROM partners p WHERE p.active = 1 ORDER BY p.organisation, p.email`).bind(utcDay(now), utcDay(now - 29 * 86400000)).all();
  return { partners: results, default_daily_limit: partnerDefaultLimit(env) };
}
export async function savePartner(env, body) {
  const email = normaliseEmail(body.email);
  if (typeof body.organisation !== 'string' || body.organisation.length > 120 || /[\u0000-\u001f\u007f]/.test(body.organisation)) fail(400, 'Enter a valid organisation name.');
  const limit = body.daily_limit === undefined ? partnerDefaultLimit(env) : body.daily_limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail(400, 'Daily scans must be between 1 and 500.');
  await env.DB.prepare(`INSERT INTO partners (email, organisation, daily_limit, active, created_at) VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(email) DO UPDATE SET organisation = excluded.organisation, daily_limit = excluded.daily_limit, active = 1`)
    .bind(email, body.organisation.trim(), limit, Date.now()).run();
  return { ok: true, email };
}
export async function removePartner(env, body) {
  const email = normaliseEmail(body.email);
  await env.DB.prepare('DELETE FROM partners WHERE email = ?').bind(email).run();
  await env.DB.prepare("DELETE FROM operator_sessions WHERE role = 'partner' AND partner_email = ?").bind(email).run();
  return { ok: true, email };
}
