// Device-local URL-only case management. No source-page reads, server storage
// or IP accounting. The only network path is the opt-in AI draft for one known
// URL, through the injected aiDraft; its result is stored here. The injected
// store owns persistence.
import { HELP_LINKS } from './platforms.js';
import { FOLLOWUP_MS, TAKEDOWN_SUPPORT, channelForUrl, urlValue, drafts } from './takedowns.js';
import { aiDraftPayload, localAiDraft, AI_FACTS_LIMIT } from './browser-ai-draft.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['removed', 'refused', 'escalated']);
export function caseIsDemo(record) {
  // Preserve the exact built-in fixture created by older versions which did
  // not persist a flag. Ordinary user-supplied URLs do not trigger this rule.
  return record.is_demo === true || (record.reporter_email === 'alex@example.com' && record.affected_name === 'Alex Example'
    && record.items?.length === 2 && record.items.some(i => i.url === 'https://www.reddit.com/r/example/comments/demo_request')
    && record.items.some(i => i.url === 'https://publisher.example/post/demo-request'));
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function text(value, max, label, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) fail(400, `Invalid ${label}.`);
  return value.trim();
}

function bodyValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'Invalid JSON body.');
  return value;
}

/** Returns the local equivalent of the existing takedown API's parsed JSON.
 * Errors carry .status for the UI. store.update must atomically read the current
 * record and run its synchronous mutator, committing only a successful return.
 */
export function createBrowserTakedowns({ store, aiDraft, now = Date.now, uuid = () => crypto.randomUUID() }) {
  for (const method of ['get', 'put', 'remove', 'update']) {
    if (typeof store?.[method] !== 'function') throw new TypeError(`Case store requires ${method}().`);
  }

  const getCase = async id => {
    const record = await store.get('case', id);
    if (!record) fail(404, 'Case not found.');
    return record;
  };

  return async function handle(path, { method = 'GET', body } = {}) {
    if (path === '/api/takedowns' && method === 'POST') {
      const b = bodyValue(body);
      if (!['adult', 'under18', 'unknown'].includes(b.age_at_creation)) fail(400, 'Choose the person’s age when the imagery was created.');
      if (b.age_at_creation !== 'adult') return {
        help_only: true,
        reason: 'Use the specialist reporting services for imagery created when someone was under 18, or when their age is uncertain. Do not upload, download or forward imagery to use this app.',
        links: HELP_LINKS.filter(x => /Take It Down|Commission|Police|SHECARES/.test(x.name)).map(link => ({ ...link })),
      };
      if (b.authorised !== true || b.shared_without_consent !== true) fail(400, 'Confirm your authority to report and that the imagery was shared without consent.');
      if (!['self', 'representative'].includes(b.role)) fail(400, 'Choose whether you are reporting for yourself or as an authorised representative.');
      const name = text(b.affected_name, 80, 'affected person’s name', true);
      const reporter = text(b.reporter_name, 80, 'reporter name', true);
      const email = text(b.reporter_email, 254, 'contact email', true);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid contact email.');
      if (!Array.isArray(b.urls) || !b.urls.length || b.urls.length > 25) fail(400, 'Enter between 1 and 25 URLs.');
      // Validate every input before any write; preserve content-identifying
      // query strings and fragments while deduplicating identical URLs.
      const urls = [...new Set(b.urls.map(url => urlValue(url, fail)))];
      const timestamp = now(), id = uuid();
      const record = {
        id, created_at: timestamp, is_demo: b.is_demo === true, affected_name: name, reporter_name: reporter,
        reporter_email: email, role: b.role, authority_confirmed_at: timestamp,
        items: urls.map((url, index) => ({
          id: index + 1, url, host: new URL(url).hostname, created_at: timestamp,
          status: 'ready', sent_at: null, due_at: null, followed_up_at: null, reference: '',
        })),
      };
      await store.put('case', id, record);
      return { id };
    }

    const match = typeof path === 'string' && path.match(/^\/api\/takedowns\/([^/]+)(?:\/items\/(\d+)(?:\/(draft|draft-ai))?)?$/);
    if (!match) fail(404, 'Takedown route not found.');
    const [, id, rawItemId, action] = match;
    if (!UUID.test(id)) fail(404, 'Case not found.');

    if (!rawItemId && method === 'GET') {
      const record = await getCase(id), timestamp = now();
      const items = record.items.map(item => {
        const draft = drafts(record, item);
        const initial = item.edited_drafts?.initial, followup = item.edited_drafts?.followup;
        if (initial) { draft.subject = initial.subject; draft.body = initial.body; if (initial.source === 'ai') draft.source = 'ai'; }
        if (followup) { draft.followup_subject = followup.subject; draft.followup_body = followup.body; }
        return { ...item, channel: channelForUrl(item.url),
          due: item.status === 'sent' && item.due_at !== null && item.due_at <= timestamp, draft };
      });
      return { ...record, is_demo: caseIsDemo(record), items, due_count: items.filter(item => item.due).length,
        support_links: TAKEDOWN_SUPPORT.map(link => ({ ...link })) };
    }

    if (!rawItemId && method === 'DELETE') {
      await getCase(id);
      await store.remove('case', id);
      return { deleted: true };
    }

    if (rawItemId && action === 'draft-ai' && method === 'POST') {
      // Opt-in AI draft for one known URL: only the link, platform, request type
      // and typed facts are sent. Names and email are filled in locally.
      if (typeof aiDraft !== 'function') fail(404, 'AI drafting is not available.');
      const itemId = Number(rawItemId);
      if (!Number.isSafeInteger(itemId) || itemId < 1) fail(404, 'URL not found in this case.');
      const b = bodyValue(body);
      if (Object.keys(b).some(key => !['consent', 'facts'].includes(key))) fail(400, 'Unexpected AI draft fields.');
      if (b.consent !== true) fail(400, 'Confirm that you agree to send this link for an AI draft.');
      const facts = text(b.facts, AI_FACTS_LIMIT, 'facts to include');
      const record = await getCase(id);
      if (caseIsDemo(record)) fail(400, 'AI drafting is not available for the demonstration queue.');
      const item = record.items.find(entry => entry.id === itemId);
      if (!item) fail(404, 'URL not found in this case.');
      const fallback = drafts(record, item);
      const result = await aiDraft(aiDraftPayload({ requestType: 'intimate_image', url: item.url, platform: channelForUrl(item.url).name, facts }));
      if (typeof result?.draft !== 'string' || result.draft.length > 20000) fail(502, 'The AI service returned no usable draft. Use the template draft instead.');
      const local = localAiDraft(result.draft, { fallbackSubject: fallback.subject, name: record.reporter_name, email: record.reporter_email });
      const updated = await store.update('case', id, current => {
        const old = current.items.find(entry => entry.id === itemId);
        if (!old) fail(404, 'URL not found in this case.');
        const next = { ...old, edited_drafts: { ...old.edited_drafts, initial: { subject: local.subject, body: local.body, source: 'ai' } } };
        return { ...current, items: current.items.map(entry => entry.id === itemId ? next : entry) };
      });
      if (!updated) fail(404, 'Case not found.');
      return { draft: { subject: local.subject, body: local.body, source: 'ai' }, model: String(result.model || '').slice(0, 100), provider: String(result.provider || '').slice(0, 40) };
    }

    if (rawItemId && action !== 'draft-ai' && method === 'PATCH') {
      const itemId = Number(rawItemId);
      if (!Number.isSafeInteger(itemId) || itemId < 1) fail(404, 'URL not found in this case.');
      const b = bodyValue(body);
      if (action === 'draft') {
        if (Object.keys(b).some(key => !['mode', 'subject', 'body'].includes(key))
          || !['initial', 'followup'].includes(b.mode)
          || typeof b.subject !== 'string' || b.subject.length > 180
          || typeof b.body !== 'string' || b.body.length > 20000) fail(400, 'Use a valid draft mode, subject of up to 180 characters and body of up to 20,000 characters.');
        // Preserve exact edits, including blank drafts and deliberate spacing.
        // The update reads the latest case so autosave cannot lose a concurrent
        // status change, overwrite the other mode, or recreate a deleted case.
        const updated = await store.update('case', id, record => {
          const old = record.items.find(item => item.id === itemId);
          if (!old) fail(404, 'URL not found in this case.');
          const previous = old.edited_drafts?.[b.mode];
          const item = { ...old, edited_drafts: { ...old.edited_drafts,
            [b.mode]: { subject: b.subject, body: b.body, ...(previous?.source === 'ai' ? { source: 'ai' } : {}) } } };
          return { ...record, items: record.items.map(current => current.id === itemId ? item : current) };
        });
        if (!updated) fail(404, 'Case not found.');
        return { ok: true };
      }
      if (!['sent', 'followed_up', ...TERMINAL].includes(b.status)) fail(400, 'Choose a valid report status.');
      if ((b.status === 'sent' || b.status === 'followed_up') && b.accuracy_confirmed !== true) fail(400, 'Confirm that you reviewed and submitted the request yourself.');
      const reference = b.reference === undefined ? null : text(b.reference, 200, 'platform reference');
      const timestamp = now(), sentAt = b.sent_at ?? timestamp;
      if (b.status === 'sent' && (!Number.isSafeInteger(sentAt) || sentAt <= 0 || sentAt > timestamp)) fail(400, 'Use the actual sending time, up to the current time.');

      // Every status check and merge reads the latest record inside one store
      // transaction. Duplicate actions cannot postpone reminders, discard an
      // omitted reference, revive deleted cases, or reopen terminal reports.
      const updated = await store.update('case', id, record => {
        if (!record) fail(404, 'Case not found.');
        const old = record.items.find(item => item.id === itemId);
        if (!old) fail(404, 'URL not found in this case.');
        if (TERMINAL.has(old.status) && !TERMINAL.has(b.status)) fail(409, 'This report is closed. Its reminder cannot be restarted.');
        let item;
        if (b.status === 'sent') {
          if (old.status === 'followed_up') fail(409, 'The follow-up has already been recorded.');
          if (!['ready', 'sent'].includes(old.status)) fail(409, 'The report changed. Refresh the case before continuing.');
          item = { ...old, status: 'sent', sent_at: old.sent_at ?? sentAt, due_at: old.due_at ?? (old.sent_at ?? sentAt) + FOLLOWUP_MS };
        } else if (b.status === 'followed_up') {
          if (!old.sent_at) fail(409, 'Record the original request as sent before recording a follow-up.');
          if (!['sent', 'followed_up'].includes(old.status)) fail(409, 'The report changed. Refresh the case before continuing.');
          item = { ...old, status: 'followed_up', followed_up_at: old.followed_up_at ?? timestamp };
        } else {
          item = { ...old, status: b.status };
        }
        if (reference !== null) item.reference = reference;
        item.history = old.status === item.status ? (old.history || []) : [...(old.history || []),{status:item.status,at:timestamp}].slice(-250);
        return { ...record, items: record.items.map(current => current.id === itemId ? item : current) };
      });
      if (!updated) fail(404, 'Case not found.');
      return { ok: true };
    }

    fail(404, 'Takedown route not found.');
  };
}
