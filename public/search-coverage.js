const engineNames = { 'google cse': 'Google CSE', google: 'Google', bing: 'Bing', brave: 'Brave',
  duckduckgo: 'DuckDuckGo', startpage: 'Startpage', qwant: 'Qwant', yahoo: 'Yahoo', mojeek: 'Mojeek', wikipedia: 'Wikipedia' };
const names = values => [...new Set((Array.isArray(values) ? values : []).filter(value => Object.hasOwn(engineNames, value)))];
const backupProviders = values => Array.isArray(values) && values.includes('serpapi') ? ['serpapi'] : [];

export function liveSearchConsentView(config) {
  const backupProvider = config?.provider === 'searxng' && config.google_backup_available === true
    && config.google_backup_provider === 'serpapi' ? 'serpapi' : null;
  const selfHosted = config?.provider === 'searxng';
  const consentCopy = selfHosted
    ? backupProvider
      ? 'I agree to share search queries with this site’s server, its self-hosted SearXNG service and the search engines it uses, and with SerpApi for Google web results when SearXNG supplies no usable Google listings. These providers may retain queries under their own policies. My scan and case records stay in this browser. *'
      : 'I agree to share search queries with this site’s server, its self-hosted SearXNG service and the search engines it uses. Upstream engines may retain queries. My scan and case records stay in this browser. *'
    : config?.provider === 'serpapi'
      ? 'I understand that live search sends search queries and my selected country through this site’s server to SerpAPI, which retains standard search data for 31 days. My scan and case records stay in this browser. *'
      : 'I agree to send search queries and any supported country preference through this site’s server to the search provider. The provider may retain queries. My scan and case records stay in this browser. *';
  const privacyText = selfHosted
    ? `With your consent, this site’s server and its self-hosted SearXNG service temporarily process search queries and pass them to external search engines.${backupProvider ? ' When SearXNG supplies no usable Google listings, the same query may also be sent to SerpApi for Google web results.' : ''} These providers may retain queries under their own policies. Source pages and images are not fetched. When you open a request for an unlisted site, only its hostname is sent to our server and to public DNS and domain-registration services to find an abuse contact.`
    : config?.provider === 'session'
      ? 'Prepared queries stay in this browser until you choose to export them. No search or report is automatically sent to an operator.'
      : 'With your consent, live search sends queries through this site’s server to the configured search provider. The provider may retain queries under its own policies. Source pages and images are not fetched. When you open a request for an unlisted site, only its hostname is sent to our server and to public DNS and domain-registration services to find an abuse contact.';
  return { backupProvider, scope: JSON.stringify([config?.provider || null, Boolean(config?.demo), backupProvider]), consentCopy, privacyText };
}

// Historical scans have no provider/filter audit. Never invent counts or claim
// a missing URL was removed by a filter when the original response wasn't saved.
export function searchCoverageView(report, currentEngines = [], currentBackupProvider = null) {
  const recorded = names(report.search_engines), current = names(currentEngines);
  const configured = names(report.configured_search_engines);
  const c = report.coverage || {}, d = c.diagnostics;
  const audited = (d?.tracked_queries || 0) > 0;
  const auditedBackup = backupProviders(d?.google_backup_providers).includes('serpapi');
  const actualBackup = backupProviders(report.google_backup_providers).includes('serpapi')
    || (auditedBackup && (d?.google_backup_recoveries || 0) > 0);
  const selected = configured.length ? configured : current;
  const absent = selected.filter(name => !recorded.includes(name));
  const engineNotice = report.provider === 'searxng' && audited && absent.length
    ? `${absent.map(name => engineNames[name]).join(', ')} supplied no usable listings in this scan${auditedBackup ? ' through SearXNG' : ''}.${configured.length ? '' : ' These engines are currently configured; the original selection was not recorded.'} A connection test does not establish coverage for every query.`
    : '';
  const active = recorded.length ? recorded : current;
  const engineText = report.provider === 'searxng'
    ? `${recorded.length ? 'Engines with results in this scan' : 'Configured engines'}: SearXNG${active.length ? ` · ${active.map(name => engineNames[name]).join(', ')}` : ''}.${actualBackup ? ' Additional source with results: Google via SerpApi.' : ''}`
    : `Search provider: ${report.provider || 'Unknown'}.`;
  const cseOnly = report.provider === 'searxng' && active.length === 1 && active[0] === 'google cse' && !actualBackup;
  const limitation = actualBackup
    ? 'Google via SerpApi retrieves Google web listings, but results can differ from your Google.com search. A finished scan does not establish that every relevant page has been found.'
    : cseOnly
    ? 'Google CSE searches a subset of Google’s web index. It can miss pages visible on Google.com. Broader coverage requires another general search engine or a different search provider.'
    : 'Search results can differ from Google.com. A finished scan does not establish that every relevant page has been found.';
  const countText = d?.tracked_queries
    ? `${d.returned} provider listings across ${d.attempts} responses, including repeats. ${d.no_name} did not match the supplied names; ${d.duplicates} repeated a retained URL; ${d.invalid} had invalid URLs; ${d.limited} exceeded the response limit. ${d.retained ?? c.retained ?? 0} new name matches saved from these responses.${d.google_retries ? ` ${d.google_retries} additional Google-only attempts were made; ${d.google_recoveries || 0} supplied usable Google listings.` : ''}${d.google_recovery_skips ? ` ${d.google_recovery_skips} Google recovery attempts were skipped because no allowance or time remained.` : ''}${auditedBackup && d.google_backup_attempts ? ` ${d.google_backup_attempts} backup ${d.google_backup_attempts === 1 ? 'request' : 'requests'} for Google via SerpApi ${d.google_backup_attempts === 1 ? 'was' : 'were'} made; ${d.google_backup_recoveries || 0} supplied usable Google listings.` : ''}${auditedBackup && d.google_backup_skips ? ` ${d.google_backup_skips} SerpApi backup attempts were skipped because no allowance or time remained.` : ''}${d.complete ? '' : ' These counts cover only the requests with recorded diagnostics.'}`
    : d?.complete && report.status !== 'done'
      ? 'Response counts will appear as the search requests finish.'
      : 'This saved scan predates request diagnostics. We cannot tell whether an absent URL was missing from the provider response or discarded before it was saved.';
  const exclusions = `${c.professional || 0} professional matches and ${c.sensitive || 0} sensitive matches excluded from this general list. ${report.moreCount || 0} additional reviewable matches are previewed below.`;
  const historyText = c.carried
    ? `${c.carried} earlier ${c.carried === 1 ? 'finding is' : 'findings are'} retained from a matching saved scan. They were not returned by this scan; their absence does not confirm removal.` : '';
  const authorizedBackup = report.google_backup_consent === true && report.configured_google_backup_provider === 'serpapi';
  const backupNotice = report.provider !== 'searxng' ? '' : authorizedBackup
    ? 'SerpApi backup was authorized for this scan. The recorded counts show whether it ran and supplied usable Google listings.'
    : currentBackupProvider === 'serpapi' || report.configured_google_backup_provider === 'serpapi'
      ? 'This saved scan did not authorize the SerpApi backup. Start a new scan and accept the updated search consent to enable it.' : '';
  return { engineText, engineNotice, limitation, countText, exclusions, historyText, backupNotice, cseOnly };
}

// Privacy copy for opt-in AI drafting, driven by /api/config. The provider name
// comes from server configuration; static HTML uses a neutral wording.
export function aiDraftingNotice(config) {
  const enabled = config?.ai_drafting_enabled === true;
  const provider = enabled && typeof config.ai_provider_name === 'string' && config.ai_provider_name.trim()
    ? config.ai_provider_name.trim().slice(0, 80) : 'our AI provider';
  return `AI drafting is optional: if you choose “Draft with AI”, the details of that one result are sent to ${provider} to write a draft. Nothing else is sent, and we don’t store it.${enabled ? '' : ' AI drafting is currently switched off.'} Matching rules and request templates run in this browser.`;
}
