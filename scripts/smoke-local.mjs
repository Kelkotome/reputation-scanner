// Read-only checks against a local Worker. No live search or contact submission.
import assert from 'node:assert/strict';
const base = new URL(process.argv[2] || 'http://localhost:8787');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('Use a local development Worker URL.');
const request = path => fetch(new URL(path, base), { signal: AbortSignal.timeout(10000) });
const config = await (await request('/api/config')).json();
assert.equal(config.storage, 'browser');
assert.equal(config.cloud_ai_enabled, false);
for (const path of ['/api/scan', '/api/scan/fixture', '/api/hit/1', '/api/takedowns', '/api/help', '/api/unlock']) {
  const response = await request(path);
  assert.equal(response.status, 410, path);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}
for (const path of ['/', '/report', '/contact', '/help', '/takedowns']) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  const html = await response.text();
  assert.doesNotMatch(html, /quick[- ]exit/i);
  assert.match(html, /123 Reputation/);
}
for (const path of ['/privacy.html', '/terms.html']) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  assert.match(await response.text(), /<html/i, path);
}
const robots = await request('/robots.txt');
assert.equal(robots.status, 200);
assert.match(await robots.text(), /^User-agent: \*\nAllow: \/\n?$/);
const bundle = await request('/local-api.js');
assert.equal(bundle.status, 200);
assert.match(await bundle.text(), /indexedDB/);
console.log(`PASS: browser storage server, retired storage routes, five pages and browser bundle. Live relay: ${config.search_relay_enabled ? 'enabled' : 'disabled'}. No searches or submissions made.`);
