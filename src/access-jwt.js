// Verifies Cloudflare Access identity tokens (Cf-Access-Jwt-Assertion).
// Access proves only that the visitor controls an email address; who may do
// what is decided by this Worker. Never trust the plain email header.
const TEAM = /^[a-z0-9-]{1,63}\.cloudflareaccess\.com$/;
const CERT_TTL_MS = 60 * 60 * 1000;
const SKEW_S = 60;
const certCache = new Map();

const b64url = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0));
const decodeJson = value => JSON.parse(new TextDecoder().decode(b64url(value)));

export function accessTeam(env) {
  const team = typeof env.ACCESS_TEAM_DOMAIN === 'string' ? env.ACCESS_TEAM_DOMAIN.trim().toLowerCase() : '';
  return TEAM.test(team) ? team : null;
}
async function signingKeys(team, refresh, fetchImpl) {
  const cached = certCache.get(team);
  if (cached && !refresh && cached.fetched_at + CERT_TTL_MS > Date.now()) return cached.keys;
  // Workers reject redirect:'error'; the status check below refuses a manual redirect.
  const response = await fetchImpl(`https://${team}/cdn-cgi/access/certs`, { redirect: 'manual' });
  if (!response.ok) throw new Error('access_certs_unavailable');
  const body = await response.json();
  const keys = new Map();
  for (const jwk of Array.isArray(body?.keys) ? body.keys : []) {
    if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
    keys.set(jwk.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  certCache.set(team, { keys, fetched_at: Date.now() });
  return keys;
}
/** Returns { email } for a valid token issued for `audience`, otherwise null. */
export async function verifyAccessJwt(request, env, audience, fetchImpl = fetch) {
  const team = accessTeam(env);
  if (!team || typeof audience !== 'string' || !/^[a-f0-9]{64}$/.test(audience)) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || '';
  if (token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = decodeJson(parts[0]), payload = decodeJson(parts[1]);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    let key = (await signingKeys(team, false, fetchImpl)).get(header.kid);
    if (!key) key = (await signingKeys(team, true, fetchImpl)).get(header.kid);
    if (!key) return null;
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    if (!valid) return null;
    const now = Math.floor(Date.now() / 1000);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience) || payload.iss !== `https://${team}`) return null;
    if (!Number.isFinite(payload.exp) || payload.exp + SKEW_S < now) return null;
    if (payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf - SKEW_S > now)) return null;
    const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return { email };
  } catch { return null; }
}
export function clearAccessKeyCache() { certCache.clear(); }
