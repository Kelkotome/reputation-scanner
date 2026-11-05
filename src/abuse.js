import { registrableDomain } from './text.js';

const EMPTY = { registrar: null, registrarAbuse: null, host: null, hostAbuse: null, cloudflare: null };

/** Read only role-qualified contact data; registrant emails are not abuse contacts. */
export function parseRdap(json) {
  const abuseEmails = new Set(), orgs = new Set(), seen = new Set();
  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 30) return;
    seen.add(node);
    const roles = Array.isArray(node.roles) ? node.roles.map((x) => String(x).toLowerCase()) : [];
    for (const item of Array.isArray(node.vcardArray?.[1]) ? node.vcardArray[1] : []) {
      if (!Array.isArray(item)) continue;
      const [kind, , , raw] = item;
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (kind === 'email' && roles.includes('abuse') && value.length <= 254 && /^[^\s<>@,;:]+@[^\s<>@,;:]+\.[^\s<>@,;:]+$/.test(value)) abuseEmails.add(value.toLowerCase());
      if (kind === 'fn' && roles.includes('registrar') && value) orgs.add(value);
    }
    for (const child of Array.isArray(node.entities) ? node.entities : []) walk(child, depth + 1);
  }
  walk(json);
  return { abuseEmails: [...abuseEmails], orgs: [...orgs] };
}

function publicV4(value) {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return false;
  const [a, b, c, d] = value.split('.').map(Number);
  return [a, b, c, d].every((n) => n <= 255) && a > 0 && a < 224 && a !== 10 && a !== 127
    && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
    && !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    && !(a === 203 && b === 0 && c === 113);
}
function publicHost(host) {
  host = host.toLowerCase().replace(/\.$/, '');
  if (host.includes(':')) return false; // DNS lookups use A records only; do not route literal IPv6 URLs.
  if (/^[\d.]+$/.test(host)) return publicV4(host);
  return host.includes('.') && !/(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)
    && /^[a-z\d.-]+$/.test(host);
}
function safeUrl(raw, httpsOnly = false) {
  try {
    const u = new URL(raw);
    return (httpsOnly ? u.protocol === 'https:' : /^https?:$/.test(u.protocol)) && !u.username && !u.password
      && (!u.port || u.port === (u.protocol === 'https:' ? '443' : '80')) && publicHost(u.hostname) ? u : null;
  } catch { return null; }
}

async function cappedJson(res) {
  if (!/^(?:application\/(?:rdap\+json|dns-json|json)|text\/json)(?:;|$)/i.test(res.headers.get('content-type') || '')) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return null;
  const reader = res.body.getReader(), decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(text + decoder.decode());
      bytes += value.byteLength;
      if (bytes > 200_000) return null;
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel().catch(() => {}); }
}
async function dns(host, fetchImpl, signal) {
  const u = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`;
  const res = await fetchImpl(u, { headers: { accept: 'application/dns-json' }, redirect: 'manual', signal });
  if (!res.ok) { await res.body?.cancel().catch(() => {}); return []; }
  const data = await cappedJson(res);
  const addresses = (data?.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
  return data?.Status === 0 && addresses.length && addresses.every(publicV4) ? addresses : [];
}
async function rdap(url, fetchImpl, signal) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = safeUrl(current, true);
    if (!u) return null;
    // rdap.org is the fixed bootstrap endpoint. Every redirected host is checked first.
    if (u.hostname !== 'rdap.org' && !(await dns(u.hostname, fetchImpl, signal)).length) return null;
    const res = await fetchImpl(u.toString(), { headers: { accept: 'application/rdap+json, application/json' }, redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!location) return null;
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); return null; }
    return cappedJson(res);
  }
  return null;
}
async function timed(fn) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try { return await fn(controller.signal); } catch { return null; } finally { clearTimeout(timeout); }
}
function hostOrg(data) {
  const parsed = parseRdap(data);
  if (parsed.orgs.length) return parsed.orgs[0];
  const candidates = data?.entities || [];
  for (const e of candidates) {
    if (!(e.roles || []).some((r) => ['registrant', 'administrative', 'technical'].includes(r))) continue;
    const fn = e.vcardArray?.[1]?.find((row) => row[0] === 'fn')?.[3];
    if (typeof fn === 'string' && fn.trim()) return fn.trim();
  }
  return typeof data?.name === 'string' ? data.name : null;
}

/** No page content is fetched. Pass one Map per request to coalesce repeated domains. */
export async function lookupAbuse(url, fetchImpl = fetch, cache = new Map(), { includeSources = false } = {}) {
  const u = safeUrl(url);
  if (!u) return { ...EMPTY };
  const domain = registrableDomain(u.hostname);
  if (cache.has(domain)) return { ...await cache.get(domain) };
  const job = (async () => {
    const result = { ...EMPTY };
    const [domainData, addresses] = await Promise.all([
      timed((signal) => rdap(`https://rdap.org/domain/${encodeURIComponent(domain)}`, fetchImpl, signal)),
      timed((signal) => dns(u.hostname, fetchImpl, signal)),
    ]);
    const registrar = parseRdap(domainData);
    result.registrar = registrar.orgs[0] || null;
    result.registrarAbuse = registrar.abuseEmails[0] || null;
    if (includeSources && result.registrarAbuse) result.registrarSource = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
    if (addresses?.length) {
      const data = await timed((signal) => rdap(`https://rdap.org/ip/${addresses[0]}`, fetchImpl, signal));
      result.host = hostOrg(data);
      result.hostAbuse = parseRdap(data).abuseEmails[0] || null;
      if (includeSources && result.hostAbuse) result.networkSource = `https://rdap.org/ip/${addresses[0]}`;
      if (/cloudflare/i.test(result.host || '')) result.cloudflare = 'https://abuse.cloudflare.com';
    }
    return result;
  })();
  cache.set(domain, job);
  return { ...await job };
}
