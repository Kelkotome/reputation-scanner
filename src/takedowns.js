// URL-only case management. This module NEVER fetches a reported URL, embeds
// media, calls an AI provider, sends a request, or verifies the page's contents.
import { HELP_LINKS } from './platforms.js';

export const FOLLOWUP_MS = 14 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['removed', 'refused', 'escalated']);
const CHANNELS = [
  { domains: ['tumblr.com'], name: 'Tumblr', url: 'https://www.tumblr.com/abuse', instructions: 'Use Tumblr’s official abuse form and choose the privacy or non-consensual-content issue. Include the exact known post URL; submit any verification directly to Tumblr.' },
  { domains: ['t.me', 'telegram.me', 'telegram.org'], name: 'Telegram', url: 'https://telegram.org/faq', instructions: 'Telegram’s FAQ links to @TIDABot for reports of non-consensual intimate imagery concerning yourself or someone you represent, and explains its in-app Report action. Provide the known message link through the official reporting route.' },
  { domains: ['pornhub.com'], name: 'Pornhub', url: 'https://www.pornhub.com/content-removal', instructions: 'Use the platform’s content-removal form for non-consensual content. This route is documented by Canada’s Privacy Commissioner; availability may depend on region. Provide the known URL and complete verification directly with the platform. This app does not open or download the material.' },
  { domains: ['reddit.com', 'redd.it'], name: 'Reddit', url: 'https://support.reddithelp.com/hc/en-us/requests/new?tf_15968861076756=report_content_policy_violation&ticket_form_id=15968767746196', instructions: 'Choose non-consensual intimate media and submit the specific content URL. Reddit accepts reports by the affected person or their representative; complete any verification directly with Reddit.' },
  { domains: ['facebook.com', 'fb.com', 'fb.watch'], name: 'Facebook', url: 'https://www.meta.com/safety/topics/bullying-harassment/ncii/', instructions: 'Follow Meta’s official intimate-image reporting guidance for Facebook. Specialised forms have regional and sign-in requirements; provide any identity or authority evidence directly to Meta.' },
  { domains: ['instagram.com', 'threads.net', 'threads.com'], name: 'Instagram / Threads', url: 'https://www.meta.com/safety/topics/bullying-harassment/ncii/', instructions: 'Follow Meta’s official intimate-image reporting guidance for Instagram or Threads. Specialised forms have regional and sign-in requirements; provide verification directly to Meta.' },
  { domains: ['x.com', 'twitter.com'], name: 'X', url: 'https://help.x.com/en/forms/safety-and-sensitive-content/private-information', instructions: 'Use the privacy/intimate-media reporting route. Check the form’s eligibility and representation requirements before submitting.' },
  { domains: ['tiktok.com'], name: 'TikTok', url: 'https://www.tiktok.com/legal/report/privacy?lang=en', instructions: 'Use TikTok’s official privacy reporting flow for intimate-image concerns. Check eligibility and provide any required verification directly in its form.' },
];
export const TAKEDOWN_SUPPORT = [
  { name: 'Google Search removal', url: 'https://support.google.com/websearch/answer/16305143', detail: 'A separate request removes eligible search results, not the source page.' },
  { name: 'Singapore Online Safety Commission', url: 'https://www.osc.gov.sg/what-you-can-report/intimate-image-abuse/', detail: 'Eligible people can report intimate-image abuse directly or authorise a representative. Use the official process for any supporting evidence.' },
  { name: 'StopNCII', url: 'https://stopncii.org/', detail: 'For qualifying adult images, the affected person can create fingerprints on their own device for participating platforms.' },
];

export function channelForUrl(raw) {
  const host = new URL(raw).hostname.toLowerCase().replace(/\.$/, '');
  const match = CHANNELS.find(c => c.domains.some(d => host === d || host.endsWith('.' + d)));
  return match ? { name: match.name, url: match.url, instructions: match.instructions }
    : { name: 'Website operator', url: null, instructions: 'This host has no verified reporting route in the platform directory. Opening the request checks public infrastructure abuse contacts using only this hostname. No page, media, person’s name, or full content URL is sent for that lookup. Unresolved cases need investigation.' };
}

export function urlValue(value, fail) {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f\u007f]/.test(value)) fail(400, 'Enter a valid page URL of at most 2,048 characters.');
  let u;
  try { u = new URL(value.trim()); } catch { fail(400, 'Enter full http:// or https:// URLs, one per line.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) fail(400, 'Only HTTP(S) URLs without embedded credentials are accepted.');
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  // We never dereference any URL. These checks also prevent accidental storage
  // of internal network links and inappropriate source links in drafted reports.
  if (!host.includes('.') || host.startsWith('[') || /(^|\.)(localhost|local|internal)$/.test(host)) fail(400, 'Use a public website URL.');
  if (/^\d+(\.\d+){3}$/.test(host)) {
    const [a,b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127)) fail(400, 'Use a public website URL.');
  }
  // Preserve query parameters/fragments: they may identify the exact content.
  return u.href;
}

export function drafts(c, item) {
  const person = c.role === 'self' ? 'me' : c.affected_name;
  const authority = c.role === 'self'
    ? `I am ${c.affected_name}, the person affected by this report.`
    : `I am ${c.reporter_name}, the authorised representative of ${c.affected_name}.`;
  const end = `I confirm that the information in this request is accurate to the best of my knowledge.\n\n${c.reporter_name}\nContact: ${c.reporter_email}`;
  const body = `Hello,\n\n${authority}\n\nI am reporting intimate content that I state was shared without ${c.role === 'self' ? 'my' : "the affected person’s"} consent.\n\nContent URL: ${item.url}\n\nPlease review this URL under your policy on non-consensual intimate content and remove the content if it violates that policy. Please tell me if you need additional verification, which I can provide through your official secure process. No images are attached.\n\n${end}`;
  const date = item.sent_at ? new Date(item.sent_at).toISOString().slice(0, 10) : '[date of original report]';
  const followup = `Hello,\n\n${authority}\n\nI am following up on the report recorded as submitted on ${date} concerning intimate content involving ${person}.\nReference: ${item.reference || '[platform reference, if available]'}\nContent URL: ${item.url}\n\nPlease confirm the status of the report and whether any further information is needed through your official reporting process. No images are attached.\n\n${end}`;
  return { subject: 'Request to review intimate content shared without consent', body,
    followup_subject: 'Follow-up on intimate-content removal request', followup_body: followup };
}

/** Helper functions come from the API router: common validation and no-store JSON. */
export async function handleTakedowns(request, env, path, h) {
  const { json, readBody, text, fail, hashIp } = h;
  const db = env.DB, method = request.method;
  const queryAll = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
  const getCase = async id => {
    if (!UUID.test(id)) fail(404, 'Case not found.');
    const row = await db.prepare('SELECT * FROM takedown_cases WHERE id = ?').bind(id).first();
    if (!row) fail(404, 'Case not found.');
    return row;
  };
  if (path === '/api/takedowns' && method === 'POST') {
    const b = await readBody(request);
    if (!['adult', 'under18', 'unknown'].includes(b.age_at_creation)) fail(400, 'Choose the person’s age when the imagery was created.');
    if (b.age_at_creation !== 'adult') return json({ help_only: true,
      reason: 'Use the specialist reporting services for imagery created when someone was under 18, or when their age is uncertain. Do not upload, download or forward imagery to use this app.',
      links: HELP_LINKS.filter(x => /Take It Down|Commission|Police|SHECARES/.test(x.name)) });
    if (b.authorised !== true || b.shared_without_consent !== true) fail(400, 'Confirm your authority to report and that the imagery was shared without consent.');
    if (!['self', 'representative'].includes(b.role)) fail(400, 'Choose whether you are reporting for yourself or as an authorised representative.');
    const name = text(b.affected_name, 80, 'affected person’s name', true);
    const reporter = text(b.reporter_name, 80, 'reporter name', true);
    const email = text(b.reporter_email, 254, 'contact email', true);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Enter a valid contact email.');
    if (!Array.isArray(b.urls) || !b.urls.length || b.urls.length > 25) fail(400, 'Enter between 1 and 25 URLs.');
    const urls = [...new Set(b.urls.map(u => urlValue(u, fail)))];
    const now = Date.now(), id = crypto.randomUUID(), day = new Date(now).toISOString().slice(0,10);
    const ip = await hashIp(request, env);
    await db.prepare('INSERT OR IGNORE INTO ip_daily (day, ip_hash, scans) VALUES (?, ?, 0)').bind(day, ip).run();
    const [created] = await db.batch([
      db.prepare(`INSERT INTO takedown_cases (id, created_at, affected_name, reporter_name, reporter_email, role, authority_confirmed_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ip_daily WHERE day = ? AND ip_hash = ? AND scans < ?)`)
        .bind(id, now, name, reporter, email, b.role, now, day, ip, Math.max(0, Number(env.SCANS_PER_IP_PER_DAY ?? 50))),
      ...urls.map(url => db.prepare('INSERT INTO takedown_items (case_id, url, host, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM takedown_cases WHERE id = ?)').bind(id, url, new URL(url).hostname, now, id)),
      db.prepare('UPDATE ip_daily SET scans = scans + 1 WHERE day = ? AND ip_hash = ? AND EXISTS (SELECT 1 FROM takedown_cases WHERE id = ?)').bind(day, ip, id),
    ]);
    if (!created.meta.changes) fail(429, 'Daily case limit reached. Please try again tomorrow.');
    return json({ id }, 201);
  }
  const match = path.match(/^\/api\/takedowns\/([^/]+)(?:\/items\/(\d+))?$/);
  if (!match) fail(404, 'Takedown route not found.');
  const [, id, itemId] = match;
  const c = await getCase(id);
  if (!itemId && method === 'GET') {
    const items = (await queryAll('SELECT * FROM takedown_items WHERE case_id = ? ORDER BY id', id)).map(item => ({
      ...item, case_id: undefined, channel: channelForUrl(item.url),
      due: item.status === 'sent' && item.due_at !== null && item.due_at <= Date.now(),
      draft: drafts(c, item),
    }));
    return json({ ...c, items, due_count: items.filter(i => i.due).length, support_links: TAKEDOWN_SUPPORT });
  }
  if (!itemId && method === 'DELETE') {
    await db.batch([db.prepare('DELETE FROM takedown_items WHERE case_id = ?').bind(id), db.prepare('DELETE FROM takedown_cases WHERE id = ?').bind(id)]);
    return json({ deleted: true });
  }
  if (itemId && method === 'PATCH') {
    const b = await readBody(request);
    const old = await db.prepare('SELECT * FROM takedown_items WHERE id = ? AND case_id = ?').bind(Number(itemId), id).first();
    if (!old) fail(404, 'URL not found in this case.');
    if (!['sent', 'followed_up', ...TERMINAL].includes(b.status)) fail(400, 'Choose a valid report status.');
    if ((b.status === 'sent' || b.status === 'followed_up') && b.accuracy_confirmed !== true) fail(400, 'Confirm that you reviewed and submitted the request yourself.');
    const ref = b.reference === undefined ? null : text(b.reference, 200, 'platform reference');
    if (TERMINAL.has(old.status) && !TERMINAL.has(b.status)) fail(409, 'This report is closed. Its reminder cannot be restarted.');
    if (b.status === 'sent') {
      if (old.status === 'followed_up') fail(409, 'The follow-up has already been recorded.');
      const timestamp = b.sent_at ?? Date.now();
      if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > Date.now()) fail(400, 'Use the actual sending time, up to the current time.');
      // COALESCE protects the original sending/due date from duplicate clicks.
      const result = await db.prepare(`UPDATE takedown_items SET status = 'sent', sent_at = COALESCE(sent_at, ?),
        due_at = COALESCE(due_at, ?), reference = COALESCE(?, reference) WHERE id = ? AND case_id = ? AND status IN ('ready', 'sent')`)
        .bind(timestamp, timestamp + FOLLOWUP_MS, ref, Number(itemId), id).run();
      if (!result.meta.changes) fail(409, 'The report changed. Refresh the case before continuing.');
    } else if (b.status === 'followed_up') {
      if (!old.sent_at) fail(409, 'Record the original request as sent before recording a follow-up.');
      const result = await db.prepare(`UPDATE takedown_items SET status = 'followed_up', followed_up_at = COALESCE(followed_up_at, ?), reference = COALESCE(?, reference)
        WHERE id = ? AND case_id = ? AND status IN ('sent', 'followed_up')`).bind(Date.now(), ref, Number(itemId), id).run();
      if (!result.meta.changes) fail(409, 'The report changed. Refresh the case before continuing.');
    } else {
      await db.prepare('UPDATE takedown_items SET status = ?, reference = COALESCE(?, reference) WHERE id = ? AND case_id = ?').bind(b.status, ref, Number(itemId), id).run();
    }
    return json({ ok: true });
  }
  fail(404, 'Takedown route not found.');
}
