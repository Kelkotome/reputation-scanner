const lookups = new Map();
// Only the hostname leaves the browser, never the original path or case details.
export function lookupReportingContact(url) {
  let hostname;
  try { hostname = new URL(url).hostname; } catch { return Promise.reject(new Error('Invalid website address.')); }
  if (!lookups.has(hostname)) {
    const job = fetch('/api/reporting-contact', { method: 'POST', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostname }), signal: AbortSignal.timeout(25000) })
      .then(async response => { if (!response.ok) throw new Error('Contact lookup unavailable.'); return response.json(); });
    lookups.set(hostname, job);
    job.catch(() => lookups.delete(hostname));
  }
  return lookups.get(hostname);
}
