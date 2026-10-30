// Keep provider pages bounded without discarding ordinary web entries after 20.
export const SEARCH_RESULT_LIMIT = 100;
// Results shown in full to the user. Anything beyond stays locked behind the
// "Contact us to uncover more" flow. SHOW_LIMIT may lower it, never raise it.
export const VISIBLE_RESULT_LIMIT = 20;

const GENERAL_ENGINES = new Set(['duckduckgo', 'google', 'google cse', 'bing', 'brave', 'startpage', 'qwant', 'yahoo', 'mojeek', 'wikipedia']);

// Only public engine labels may cross the relay. Never retain arbitrary provider
// metadata, URLs, error details, or credential-like strings as provenance.
export function safeSearchEngines(values) {
  if (!Array.isArray(values)) return [];
  const engines = new Set();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const engine = value.trim().toLowerCase();
    if (GENERAL_ENGINES.has(engine)) engines.add(engine);
  }
  return [...engines];
}
