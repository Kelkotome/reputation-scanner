// Presentation-only contact gate: full records remain owned by this browser.
// Never pass result titles, snippets, full URLs or IDs to the preview renderer.
export function additionalResultPreview(hits = []) {
  const domains = new Map();
  for (const hit of hits) {
    let domain = 'Source unavailable';
    try {
      const url = new URL(hit.url);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
        domain = url.hostname.replace(/^www\./, '');
      }
    } catch { /* Invalid URLs must never become links or visible raw text. */ }
    domains.set(domain, (domains.get(domain) || 0) + 1);
  }
  return { count: hits.length, sources: [...domains].map(([domain, count]) => ({ domain, count })) };
}
