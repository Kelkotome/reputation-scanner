import { createBrowserStore } from './browser-store.js';
import { createBrowserTakedowns, caseIsDemo } from './browser-takedowns.js';
import { createBrowserScans, report } from './browser-scans.js';
import { HELP_LINKS } from './platforms.js';
import { VISIBLE_RESULT_LIMIT } from './search-limits.js';
import { validateAiDraftPayload } from './browser-ai-draft.js';

const error = (status, message) => Object.assign(new Error(message), { status });
function findingProvenance(hit) {
  const validDate = value => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
  if (hit.discovery_origin !== 'previous_scan'
    && !(hit.discovery_origin === 'search' && validDate(hit.previous_observed_at))) return {};
  // Export the historical label and observation dates. Private scan references
  // stay in the local record and never become part of a report attachment.
  const dates = ['previous_observed_at', 'last_seen_at', 'carried_into_at', 'reobserved_at'];
  return { discovery_origin: hit.discovery_origin, ...Object.fromEntries(dates
    .filter(key => validDate(hit[key]))
    .map(key => [key, hit[key]])) };
}
function validateAssistance(body) {
  const reject = () => { throw error(400, 'Review the information selected for this assistance request.'); };
  const exact = (value, keys) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) reject();
  };
  const text = (value, max) => { if (typeof value !== 'string' || value.length > max) reject(); };
  exact(body, ['name', 'email', 'message', 'help_type', 'consent', 'share_report', 'attachment', 'links']);
  text(body.name, 80); text(body.email, 254); text(body.message, 3000);
  // Optional links the user typed in (for example private Telegram groups).
  if (body.links !== undefined) {
    if (!Array.isArray(body.links) || body.links.length > 20) reject();
    for (const link of body.links) { text(link, 2048); if (!/^https?:\/\//i.test(link)) reject(); }
  }
  if (!['legal', 'investigator', 'pr', 'unsure'].includes(body.help_type)) reject();
  if (body.share_report !== undefined && typeof body.share_report !== 'boolean') reject();
  if (body.attachment !== undefined && body.share_report !== true) reject();
  if (body.share_report === true) {
    const attachment = body.attachment;
    exact(attachment, ['subject_name', 'subject_type', 'country', 'results']);
    text(attachment.subject_name, 80); text(attachment.country, 120);
    if (!['person', 'business'].includes(attachment.subject_type) || !Array.isArray(attachment.results) || attachment.results.length > VISIBLE_RESULT_LIMIT) reject();
    for (const result of attachment.results) {
      exact(result, ['url', 'title']); text(result.url, 2048); text(result.title, 500);
    }
  }
}

// An explicit allowlist is the entire network boundary. Private record routes
// never fall back to fetch, including when IndexedDB is unavailable.
export function createBrowserApi({ store = createBrowserStore(), fetchImpl = (...args) => fetch(...args), challenge } = {}) {
  let configuration;
  async function send(path, body) {
    if (!['/api/config', '/api/search-session', '/api/search', '/api/assistance', '/api/draft-ai'].includes(path)) throw error(404, 'This request is not available.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ['/api/search', '/api/draft-ai'].includes(path) ? 30000 : 20000);
    try {
      const response = await fetchImpl(path, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
        referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      let result;
      try { result = await response.json(); } catch { throw error(502, 'The service returned an unreadable response. Your browser records have been kept.'); }
      if (!response.ok) throw Object.assign(error(response.status, typeof result.error === 'string' ? result.error : 'The request could not be completed.'), {
        ...(typeof result.code === 'string' ? { code: result.code } : {}),
        ...(Number.isFinite(result.reset_at) ? { reset_at: result.reset_at } : {}),
        ...(Number.isFinite(result.retry_after_seconds) ? { retry_after_seconds: result.retry_after_seconds } : {}),
      });
      return result;
    } catch (failure) {
      if (failure.name === 'AbortError') throw error(504, 'The service took too long. Your browser records have been kept; try again.');
      throw failure;
    } finally { clearTimeout(timeout); }
  }
  async function config() {
    // Share only an in-flight read. Operator access can change in another tab.
    if (!configuration) configuration = send('/api/config').then(result => {
      if (result.storage !== 'browser') throw error(503, 'The server needs the browser-storage update before live searches can run.');
      return result;
    }).finally(() => { configuration = null; });
    return configuration;
  }
  async function checkedSend(path, body, { settings, retrying = false, beforeSend = async () => {} } = {}) {
    let cfg = settings || await config();
    if (retrying) {
      await beforeSend();
      try { return await send(path, body); }
      catch (failure) { if (failure.code !== 'bot_check_required') throw failure; cfg = await config(); }
    }
    let token;
    if (cfg.bot_check_required === true && cfg.operator !== true) {
      if (cfg.bot_check_configured !== true || typeof cfg.turnstile_site_key !== 'string' || !cfg.turnstile_site_key
        || typeof challenge !== 'function') throw Object.assign(error(503, 'The security check is unavailable. Please try again later.'), { code: 'bot_check_unavailable' });
      token = await challenge({ action: path === '/api/search-session' ? 'scan_start' : path === '/api/draft-ai' ? 'ai_draft' : 'assistance', sitekey: cfg.turnstile_site_key });
      if (typeof token !== 'string' || !token || token.length > 2048) throw Object.assign(error(403, 'Complete a fresh security check and try again.'), { code: 'bot_check_failed' });
    }
    await beforeSend();
    // Tokens are used once and never stored with browser records or reused.
    const request = send(path, { ...body, ...(token ? { challenge_token: token } : {}) });
    token = undefined;
    return request;
  }
  // Opt-in AI drafting: one result's consented fields only, never a record ID.
  // A same-day scan permit stands in for the bot check; otherwise Turnstile runs.
  async function aiDraft(payload, ticket) {
    const cfg = await config();
    if (cfg.ai_drafting_enabled !== true) throw Object.assign(error(403, 'AI drafting is switched off. Use the template draft instead.'), { code: 'ai_drafting_disabled' });
    validateAiDraftPayload(payload);
    if (typeof ticket === 'string' && /^[a-f0-9]{64}$/.test(ticket)) {
      try { return await send('/api/draft-ai', { ...payload, search_ticket: ticket }); }
      catch (failure) { if (!['search_ticket_invalid', 'search_ticket_expired', 'search_ticket_required'].includes(failure.code)) throw failure; }
    }
    return checkedSend('/api/draft-ai', payload, { settings: cfg });
  }
  const cases = createBrowserTakedowns({ store, aiDraft });
  const scans = createBrowserScans({ store, config, aiDraft, permit: (body, options) => checkedSend('/api/search-session', body, options), relay: body => send('/api/search', body) });
  async function api(path, options = {}) {
    if (typeof path !== 'string' || !path.startsWith('/api/') || path.includes('?') || path.includes('#')) throw error(404, 'Unknown toolkit operation.');
    const method = options.method || 'GET';
    if (path === '/api/config' && method === 'GET') return config();
    if (path === '/api/help-links' && method === 'GET') return { links: HELP_LINKS };
    if (path === '/api/assistance' && method === 'POST') {
      if (options.body?.consent !== true) throw error(400, 'Choose to share your assistance request before sending it.');
      // Only contact details and the explicitly previewed attachment cross the
      // boundary. Reject accidental local record identifiers or hidden fields.
      validateAssistance(options.body);
      return checkedSend('/api/assistance', options.body);
    }
    if (path === '/api/takedowns' || path.startsWith('/api/takedowns/')) return cases(path, options);
    if (path === '/api/scan' || path.startsWith('/api/scan/') || path.startsWith('/api/hit/')) return scans(path, options);
    throw error(404, 'Unknown toolkit operation. Nothing was sent to the server.');
  }
  return {
    api,
    reportData: async (kind, id) => {
      if (!['scan', 'case'].includes(kind)) throw error(400, 'Choose a saved record.');
      const row = await store.get(kind, id);
      if (!row) throw error(404, 'This record is no longer saved in this browser.');
      if (kind === 'scan') {
        const view = report(row);
        return { id, kind, name: row.full_name, created_at: row.created_at, provider: row.provider, partial: row.partial === true,
          google_backup_consent: view.google_backup_consent, configured_google_backup_provider: view.configured_google_backup_provider,
          hidden_count: view.moreCount, items: view.shown.slice(0, VISIBLE_RESULT_LIMIT).map(hit => ({ id: hit.id, title: hit.title, url: hit.url, status: hit.status, kind: hit.kind,
            created_at: hit.created_at, history: hit.history || [], ...findingProvenance(hit) })) };
      }
      return { id, kind, is_demo: caseIsDemo(row), name: row.affected_name, reporter_name: row.reporter_name, reporter_email: row.reporter_email, created_at: row.created_at,
        items: row.items.map(({ id, url, status, created_at, sent_at, followed_up_at, reference, history }) => ({ id, url, status, created_at, sent_at, followed_up_at, reference, history:history || [] })) };
    },
    setChallengeHandler: handler => { if (typeof handler !== 'function') throw new TypeError('A security-check handler is required.'); challenge = handler; },
    listSaved: async () => (await store.list()).filter(row => ['scan', 'case'].includes(row.kind)).map(row => ({
      id: row.id, kind: row.kind, label: row.kind === 'scan' ? row.full_name : row.affected_name, created_at: row.created_at,
    })).sort((a, b) => b.created_at - a.created_at),
    clearLocalData: () => store.clear(),
    assistancePreview: (scanId, hitIds) => scans(`/api/scan/${encodeURIComponent(scanId)}/attachment`, { body: hitIds === undefined ? {} : { hit_ids: hitIds } }),
  };
}

const browser = createBrowserApi();
export const localApi = browser.api;
export const reportData = browser.reportData;
export const listSaved = browser.listSaved;
export const clearLocalData = browser.clearLocalData;
export const assistancePreview = browser.assistancePreview;
export const setChallengeHandler = browser.setChallengeHandler;
