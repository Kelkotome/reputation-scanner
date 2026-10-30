// Domain-only escalation lookup. Never fetch reported pages, contact pages or media.
import { lookupAbuse } from './abuse.js';
import { dailyIpHash, fail } from './operator-access.js';
const BOOTSTRAPS = ['https://data.iana.org/rdap/dns.json', 'https://data.iana.org/rdap/ipv4.json'];
export function reportingHost(value) {
  if (typeof value !== 'string' || value.length > 253 || !/^[a-z0-9.-]+$/i.test(value)) fail(400, 'Provide a public website hostname only.');
  const host = value.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || /^[\d.]+$/.test(host) || /(?:^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host)) fail(400, 'This hostname cannot be checked through public domain records.');
  return host;
}
async function bootstrapHosts(fetchImpl) {
  const hosts = new Set(['cloudflare-dns.com']), domains = [], networks = [];
  await Promise.all(BOOTSTRAPS.map(async url => {
    try {
      const response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const reader = response.body?.getReader();
      if (!reader) return;
      let text = '', bytes = 0;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1000000) return;
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel(); }
      for (const service of JSON.parse(text).services || []) for (const value of service[1] || []) {
        const target = new URL(value);
        if (target.protocol === 'https:' && !target.username && !target.password && !target.port) {
          hosts.add(reportingHost(target.hostname));
          for (const suffix of service[0] || []) (url.endsWith('/dns.json') ? domains : networks).push({ match: suffix, base: target.href.endsWith('/') ? target.href : target.href + '/' });
        }
      }
    } catch { /* An incomplete bootstrap produces an explicit unresolved route. */ }
  }));
  return { hosts, domains, networks };
}
function ipv4Number(value) { return value.split('.').reduce((n, part) => (n * 256 + Number(part)) >>> 0, 0); }
function registryUrl(url, directory) {
  const parts = url.pathname.split('/'), value = decodeURIComponent(parts.slice(2).join('/'));
  let service;
  if (parts[1] === 'domain') service = directory.domains.filter(item => value === item.match || value.endsWith('.' + item.match)).sort((a, b) => b.match.length - a.match.length)[0];
  if (parts[1] === 'ip') service = directory.networks.filter(item => {
    const [prefix, raw] = item.match.split('/'), bits = Number(raw);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipv4Number(value) & mask) === (ipv4Number(prefix) & mask);
  }).sort((a, b) => Number(b.match.split('/')[1]) - Number(a.match.split('/')[1]))[0];
  if (!service) throw new Error('No authoritative registry available');
  return new URL(`${parts[1]}/${encodeURIComponent(value)}`, service.base);
}
export async function discoverReportingContact(hostname, fetchImpl = fetch) {
  const host = reportingHost(hostname), directory = await bootstrapHosts(fetchImpl), sources = new Map();
  const guardedFetch = (url, options) => {
    let target = new URL(url);
    if (target.hostname === 'rdap.org') { target = registryUrl(target, directory); sources.set(url, target.href); }
    if (target.protocol !== 'https:' || target.username || target.password || target.port || !directory.hosts.has(target.hostname)) throw new Error('Untrusted registry endpoint');
    return fetchImpl(target.href, { ...options, redirect: 'manual' });
  };
  const data = await lookupAbuse(`https://${host}/`, guardedFetch, new Map(), { includeSources: true });
  const contacts = [];
  if (data.cloudflare) contacts.push({ kind: 'cdn', name: 'Cloudflare', form: 'https://abuse.cloudflare.com', source: 'https://abuse.cloudflare.com',
    how: 'The public network appears to use Cloudflare. Its abuse form is an escalation route; this does not identify the origin host or prove Cloudflare stores the content.' });
  else if (data.hostAbuse) contacts.push({ kind: 'network', name: data.host || 'Network operator', email: data.hostAbuse, source: sources.get(data.networkSource) || data.networkSource,
    how: 'This abuse address comes from the public IP network’s registration data. The operator may be a CDN or intermediary, not the website publisher or origin host. Ask it to review or route the complaint.' });
  if (data.registrarAbuse) contacts.push({ kind: 'registrar', name: data.registrar || 'Domain registration contact', email: data.registrarAbuse,
    source: sources.get(data.registrarSource) || data.registrarSource, how: 'Domain-registration abuse contact. This is an escalation destination, not proof of who hosts the page. A registrar may be unable to remove individual posts.' });
  return { hostname: host, status: contacts.length ? 'escalation_available' : 'needs_investigation', contacts,
    limitation: 'Public DNS and registration data cannot reliably reveal every origin host. No page or media was fetched; no complaint was sent.' };
}
export async function reportingContactRoute(request, env, readBody) {
  if (request.method !== 'POST') fail(405, 'Use POST for contact lookup.');
  if (request.headers.get('Origin') !== new URL(request.url).origin) fail(403, 'Use this app to look up a reporting route.');
  const body = await readBody(request);
  if (!body || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'hostname')) fail(400, 'Send only the website hostname.');
  const host = reportingHost(body.hostname), owner = await dailyIpHash(request, env), bucket = Math.floor(Date.now() / 60000);
  const limit = await env.DB.prepare(`INSERT INTO public_abuse_counters (owner_hash, scope, bucket, requests, expires_at)
    VALUES (?, 'reporting-contact', ?, 1, ?) ON CONFLICT(owner_hash, scope, bucket) DO UPDATE SET requests = requests + 1 RETURNING requests`)
    .bind(owner, bucket, Date.now() + 120000).first();
  if (limit.requests > 20) fail(429, 'Please wait a minute before looking up more contacts.');
  return new Response(JSON.stringify(await discoverReportingContact(host)), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
