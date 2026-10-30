// Browser half of opt-in AI drafting. It sends only the fields named in the
// consent text for one result, and keeps the returned draft in IndexedDB.
export const AI_FACTS_LIMIT = 2000;
const KEYS = ['consent', 'request_type', 'title', 'url', 'snippet', 'platform', 'facts'];
const LIMITS = { request_type: 40, title: 500, url: 2048, snippet: 2000, platform: 120, facts: AI_FACTS_LIMIT };

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

/** Builds the exact payload. Nothing else from the scan or case is included. */
export function aiDraftPayload({ requestType, url, title = '', snippet = '', platform = '', facts = '' }) {
  if (typeof facts !== 'string' || facts.length > AI_FACTS_LIMIT) fail(400, `Keep the facts to include under ${AI_FACTS_LIMIT.toLocaleString('en')} characters.`);
  const clip = (value, max) => String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max);
  const payload = { consent: true, request_type: requestType, url: clip(url, LIMITS.url),
    title: clip(title, LIMITS.title), snippet: clip(snippet, LIMITS.snippet), platform: clip(platform, LIMITS.platform), facts: clip(facts, LIMITS.facts) };
  for (const key of ['title', 'snippet', 'platform', 'facts']) if (!payload[key]) delete payload[key];
  return payload;
}

/** Rejects anything outside the consented fields before it can reach the network. */
export function validateAiDraftPayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !KEYS.includes(key))) fail(400, 'Only the details of this one result can be sent for an AI draft.');
  if (body.consent !== true) fail(400, 'Confirm that you agree to send this one result for an AI draft.');
  for (const [key, max] of Object.entries(LIMITS)) {
    if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > max)) fail(400, 'Only the details of this one result can be sent for an AI draft.');
  }
  if (!/^https?:\/\//i.test(body.url || '')) fail(400, 'AI drafting needs a web page link.');
}

/** Splits "Subject: ..." from the body, then fills placeholders locally. The
 * name and email are added here, in the browser; they were never sent. */
export function localAiDraft(text, { fallbackSubject = '', name = '', email = '' } = {}) {
  const value = String(text || '').replace(/\r\n?/g, '\n').trim();
  const match = value.match(/^subject:[ \t]*([^\n]{1,180})\n+/i);
  let subject = match ? match[1].trim() : fallbackSubject, body = match ? value.slice(match[0].length).trim() : value;
  const fill = (input) => {
    let out = input;
    if (name) out = out.replace(/\[your (?:full )?name\]/gi, name);
    if (email) out = out.replace(/\[your (?:contact )?email(?: address)?\]/gi, email);
    return out;
  };
  subject = fill(subject).replace(/[\r\n]+/g, ' ').slice(0, 180);
  body = fill(body).slice(0, 20000);
  if (!body) fail(502, 'The AI service returned no usable draft. Use the template draft instead.');
  return { subject, body };
}
