// Sending requires review. Optional offline connections and approved follow-up
// bodies are encrypted, retained at most 30 days, and never used to read inboxes.
import { fail, digest, dailyIpHash } from './operator-access.js';

const encoder = new TextEncoder();
export const FOLLOWUP_DELAY = 14 * 86400000;
const RETENTION = 30 * 86400000;
const mailboxOwner = (env, provider, address) => digest(`${env.EMAIL_TOKEN_KEY}:mailbox:${provider}:${address.toLowerCase()}`);
const ownerFor = (env, s) => mailboxOwner(env, s.provider, s.account.email);
const providers = {
  gmail: { prefix: 'GOOGLE', authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token',
    profile: 'https://www.googleapis.com/oauth2/v2/userinfo', scope: 'https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send', sendScope: 'https://www.googleapis.com/auth/gmail.send' },
  outlook: { prefix: 'MICROSOFT', authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize', token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    profile: 'https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', scope: 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Send', sendScope: 'Mail.Send' },
};
const random = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const un64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const url64 = bytes => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const json = (value, extra = {}) => new Response(JSON.stringify(value), { headers: { ...headers, ...extra } });
function origin(env) {
  try {
    const u = new URL(env.EMAIL_APP_ORIGIN);
    if (u.origin !== env.EMAIL_APP_ORIGIN || (u.protocol !== 'https:' && !(env.LOCAL_DEVELOPMENT === 'true' && ['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol === 'http:'))) return null;
    return u.origin;
  } catch { return null; }
}
const configured = (env, provider) => Boolean(Object.hasOwn(providers, provider) && origin(env) && /^[a-f0-9]{64}$/i.test(env.EMAIL_TOKEN_KEY || '') && env[`${providers[provider].prefix}_CLIENT_ID`] && env[`${providers[provider].prefix}_CLIENT_SECRET`]);
function cookieName(request, kind) { return `${new URL(request.url).protocol === 'https:' ? '__Host-' : ''}rep_email_${kind}`; }
function cookie(request, kind, value, age) { return `${cookieName(request, kind)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`; }
function readCookie(request, kind) {
  const matches = (request.headers.get('Cookie') || '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${cookieName(request, kind)}=`));
  const value = matches.length === 1 ? matches[0].split('=')[1] : '';
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
async function key(env) { return crypto.subtle.importKey('raw', Uint8Array.from(env.EMAIL_TOKEN_KEY.match(/../g), n => parseInt(n, 16)), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function seal(env, value, context) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(context) }, await key(env), encoder.encode(JSON.stringify(value)));
  return `${b64(iv)}.${b64(encrypted)}`;
}
async function unseal(env, value, context) {
  const [iv, encrypted] = value.split('.');
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: un64(iv), additionalData: encoder.encode(context) }, await key(env), un64(encrypted))));
}
async function providerFetch(url, options = {}) {
  return fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
}
function email(value) { return typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(value); }
async function session(request, env) {
  const token = readCookie(request, 'session');
  if (!token) return null;
  const id = await digest(token);
  const row = await env.DB.prepare('SELECT * FROM email_sessions WHERE id = ? AND expires_at > ?').bind(id, Date.now()).first();
  if (!row || !configured(env, row.provider)) return null;
  try { return { ...row, account: await unseal(env, row.sealed, id) }; } catch { return null; }
}
export async function cleanupEmail(env) {
  await env.DB.prepare("UPDATE email_followups SET status = 'unknown', sealed = '', updated_at = ? WHERE status IN ('processing', 'pending') AND updated_at < ?").bind(Date.now(), Date.now() - 3600000).run();
  for (const table of ['email_oauth', 'email_sessions', 'email_sends', 'email_followups']) await env.DB.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).bind(Date.now()).run();
  await env.DB.prepare('DELETE FROM email_owners WHERE NOT EXISTS (SELECT 1 FROM email_sessions WHERE id = email_owners.session_id) AND NOT EXISTS (SELECT 1 FROM email_followups WHERE session_id = email_owners.session_id)').run();
}
async function connect(request, env, body) {
  const p = providers[body.provider];
  if (!configured(env, body.provider)) fail(503, 'This email provider is not configured yet. You can still preview or copy your draft.');
  const owner = await dailyIpHash(request, env), bucket = Math.floor(Date.now() / 60000);
  const limit = await env.DB.prepare(`INSERT INTO public_abuse_counters (owner_hash, scope, bucket, requests, expires_at)
    VALUES (?, 'email-connect', ?, 1, ?) ON CONFLICT(owner_hash, scope, bucket)
    DO UPDATE SET requests = requests + 1 RETURNING requests`).bind(owner, bucket, Date.now() + 120000).first();
  if (limit.requests > 10) fail(429, 'Too many email connection attempts. Please wait a minute.');
  await cleanupEmail(env);
  const binding = random(), state = random(), verifier = random(), id = await digest(state);
  const prior = readCookie(request, 'oauth');
  if (prior) await env.DB.prepare('DELETE FROM email_oauth WHERE binding = ?').bind(await digest(prior)).run();
  await env.DB.prepare('INSERT INTO email_oauth (id, binding, provider, sealed, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, await digest(binding), body.provider, await seal(env, { verifier, offline: body.offline === true, expected_email:body.expected_email || null }, id), Date.now() + 600000).run();
  const target = new URL(p.authorize);
  const args = { client_id: env[`${p.prefix}_CLIENT_ID`], redirect_uri: `${origin(env)}/api/email/callback/${body.provider}`, response_type: 'code', scope: p.scope,
    state, code_challenge: url64(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))), code_challenge_method: 'S256', prompt: 'select_account' };
  if (body.provider === 'gmail') { args.access_type = body.offline ? 'offline' : 'online'; if (body.offline) args.prompt = 'consent select_account'; }
  if (body.provider === 'outlook' && body.offline) args.scope += ' offline_access';
  for (const [k, v] of Object.entries(args)) target.searchParams.set(k, v);
  return json({ url: target.href }, { 'Set-Cookie': cookie(request, 'oauth', binding, 600) });
}
export async function emailCallback(request, env) {
  const url = new URL(request.url), provider = url.pathname.split('/').pop();
  const redirectHeaders = new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', Location: '/email-connected.html#failed' });
  redirectHeaders.append('Set-Cookie', cookie(request, 'oauth', '', 0));
  try {
    if (request.method !== 'GET' || url.origin !== origin(env) || !configured(env, provider)) throw new Error();
    const state = url.searchParams.get('state'), binding = readCookie(request, 'oauth');
    if (!binding || !/^[a-f0-9]{64}$/.test(state || '')) throw new Error();
    const id = await digest(state);
    const pending = await env.DB.prepare('DELETE FROM email_oauth WHERE id = ? AND binding = ? AND provider = ? AND expires_at > ? RETURNING *')
      .bind(id, await digest(binding), provider, Date.now()).first();
    if (!pending || url.searchParams.has('error')) throw new Error();
    const code = url.searchParams.get('code');
    if (!code || code.length > 8192) throw new Error();
    const p = providers[provider], { verifier, offline, expected_email } = await unseal(env, pending.sealed, id);
    const response = await providerFetch(p.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
      client_id: env[`${p.prefix}_CLIENT_ID`], client_secret: env[`${p.prefix}_CLIENT_SECRET`], grant_type: 'authorization_code', code,
      redirect_uri: `${origin(env)}/api/email/callback/${provider}`, code_verifier: verifier,
    }) });
    if (!response.ok) throw new Error();
    const tokens = await response.json();
    const scopes = String(tokens.scope || '').split(' ');
    if (!tokens.access_token || String(tokens.token_type).toLowerCase() !== 'bearer' || !scopes.some(s => s === p.sendScope || s === `https://graph.microsoft.com/${p.sendScope}`)) throw new Error();
    const profileResponse = await providerFetch(p.profile, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!profileResponse.ok) throw new Error();
    const profile = await profileResponse.json();
    const address = provider === 'gmail' ? (profile.verified_email === true ? profile.email : null) : (profile.mail || profile.userPrincipalName);
    if (!email(address)) throw new Error();
    if (expected_email && expected_email.toLowerCase() !== address.toLowerCase()) {
      redirectHeaders.set('Location','/email-connected.html#mismatch');
      return new Response(null,{status:303,headers:redirectHeaders});
    }
    const seconds = Math.min(3600, Number(tokens.expires_in) - 60);
    if (!Number.isFinite(seconds) || seconds < 60) throw new Error();
    const token = random(), sid = await digest(token);
    const owner = await mailboxOwner(env, provider, address);
    // Fresh provider authentication recovers history even if the old cookie was
    // lost. Reconnection deliberately cancels prior queues, as disclosed in UI.
    const previous = await env.DB.prepare('SELECT session_id FROM email_owners WHERE owner_hash = ?').bind(owner).all();
    for (const row of previous.results) {
      await cancelSession(env, row.session_id);
      await env.DB.prepare('DELETE FROM email_sessions WHERE id = ?').bind(row.session_id).run();
    }
    const old = readCookie(request, 'session');
    if (old) {
      await cancelSession(env, await digest(old));
      await env.DB.prepare('DELETE FROM email_sessions WHERE id = ?').bind(await digest(old)).run();
    }
    // Offline access must actually have been granted; otherwise stay short-lived.
    const refresh = offline && typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null;
    const lifetime = refresh ? RETENTION / 1000 : seconds;
    await env.DB.prepare('INSERT INTO email_sessions (id, provider, sealed, expires_at) VALUES (?, ?, ?, ?)')
      .bind(sid, provider, await seal(env, { token: tokens.access_token, email: address, refresh, token_expires_at: Date.now() + seconds * 1000 }, sid), Date.now() + lifetime * 1000).run();
    await env.DB.prepare('INSERT INTO email_owners (session_id, owner_hash) VALUES (?, ?)').bind(sid, owner).run();
    redirectHeaders.append('Set-Cookie', cookie(request, 'session', token, Math.floor(lifetime)));
    redirectHeaders.set('Location', '/email-connected.html#connected');
  } catch { /* Never reflect OAuth codes, tokens or provider errors. */ }
  return new Response(null, { status: 303, headers: redirectHeaders });
}
export function validateMessage(body) {
  if (!body || Object.keys(body).some(k => !['request_id', 'from', 'to', 'subject', 'body', 'confirmed', 'followup'].includes(k)) || body.confirmed !== true
    || !/^[a-f0-9-]{36}$/.test(body.request_id || '') || !email(body.to) || !email(body.from)
    || typeof body.subject !== 'string' || !body.subject.trim() || body.subject.length > 180 || /[\r\n\x00-\x1f\x7f]/.test(body.subject)
    || typeof body.body !== 'string' || !body.body.trim() || body.body.length > 20000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.body)) fail(400, 'Review the recipient, subject and message before sending.');
  if (/\[[^\]\r\n]{2,300}\]/.test(body.body + body.subject)) fail(400, 'Replace or remove all bracketed template placeholders before sending.');
  return { to: body.to, subject: body.subject, body: body.body };
}
export function gmailMessage(account, message) {
  // MIME body and subject are encoded, so user content cannot inject headers.
  const content = b64(encoder.encode(message.body.replace(/\r?\n/g, '\r\n'))).match(/.{1,76}/g).join('\r\n');
  const subject = Array.from(message.subject).reduce((chunks, c) => {
    if (!chunks.length || encoder.encode(chunks[chunks.length - 1] + c).length > 36) chunks.push(c); else chunks[chunks.length - 1] += c;
    return chunks;
  }, []).map(s => `=?UTF-8?B?${b64(encoder.encode(s))}?=`).join('\r\n ');
  return url64(encoder.encode(`From: ${account.email}\r\nTo: ${message.to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${content}`));
}
async function send(request, env, body) {
  const message = validateMessage(body), s = await session(request, env);
  if (!s) fail(401, 'Connect your email account again before sending.');
  if (body.from.toLowerCase() !== s.account.email.toLowerCase()) fail(409, 'The connected account changed. Review the sender again before sending.');
  let followup = null;
  if (body.followup !== undefined) {
    if (env.LOCAL_DEVELOPMENT === 'true') fail(409, 'Automatic follow-ups require the hosted scheduler. This local preview cannot schedule them.');
    if (!body.followup || Object.keys(body.followup).some(k => !['subject', 'body'].includes(k))) fail(400, 'Review your follow-up.');
    followup = validateMessage({ ...body, followup: undefined, subject: body.followup.subject, body: body.followup.body });
    if (!s.account.refresh || s.expires_at < Date.now() + FOLLOWUP_DELAY + 86400000) fail(409, 'Reconnect with automatic follow-ups enabled before scheduling.');
  }
  const fingerprint = await digest(JSON.stringify(followup ? { message, followup } : message));
  const existing = await env.DB.prepare('SELECT fingerprint, status FROM email_sends WHERE session_id = ? AND request_id = ?').bind(s.id, body.request_id).first();
  if (existing) {
    if (existing.fingerprint !== fingerprint) fail(409, 'This send request was already used for a different message.');
    return json({ status: existing.status, duplicate: true, ...(followup ? { followup: await followupReceipt(env, s.id, body.request_id) } : {}) });
  }
  // Atomic reservation also limits each connected session to 25 submissions.
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO email_sends (session_id, request_id, fingerprint, status, expires_at)
    SELECT ?, ?, ?, 'unknown', ? WHERE (SELECT COUNT(*) FROM email_sends WHERE session_id = ?) < 25`)
    .bind(s.id, body.request_id, fingerprint, Date.now() + 86400000, s.id).run();
  if (!inserted.meta?.changes) fail(409, 'A send is already in progress or this session has reached its sending limit. Check Sent mail before trying again.');
  if (followup) await env.DB.prepare("INSERT INTO email_followups (session_id, request_id, sealed, status, updated_at, expires_at) VALUES (?, ?, ?, 'pending', ?, ?)")
    .bind(s.id, body.request_id, await seal(env, followup, `${s.id}:${body.request_id}`), Date.now(), Date.now() + RETENTION).run();
  let status = 'unknown';
  try {
    await refreshAccount(env, s);
    status = await deliver(s, message);
  } catch { /* A timeout may follow acceptance; never retry automatically. */ }
  await env.DB.prepare('UPDATE email_sends SET status = ? WHERE session_id = ? AND request_id = ?').bind(status, s.id, body.request_id).run();
  if (followup) {
    const now = Date.now();
    await env.DB.prepare("UPDATE email_followups SET status = ?, first_sent_at = ?, due_at = ?, updated_at = ?, sealed = CASE WHEN ? = 'accepted' THEN sealed ELSE '' END WHERE session_id = ? AND request_id = ? AND status = 'pending'")
      .bind(status === 'accepted' ? 'queued' : status, status === 'accepted' ? now : null, status === 'accepted' ? now + FOLLOWUP_DELAY : null, now, status, s.id, body.request_id).run();
  }
  return json({ status, ...(followup ? { followup: await followupReceipt(env, s.id, body.request_id) } : {}) });
}
async function deliver(s, message) {
  const response = await providerFetch(s.provider === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send' : 'https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST', headers: { Authorization: `Bearer ${s.account.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(s.provider === 'gmail' ? { raw: gmailMessage(s.account, message) } : {
      message: { subject: message.subject, body: { contentType: 'Text', content: message.body }, toRecipients: [{ emailAddress: { address: message.to } }] }, saveToSentItems: true,
    }),
  });
  const status = response.ok ? 'accepted' : response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown';
  await response.body?.cancel(); return status;
}
async function refreshAccount(env, s) {
  if (!s.account.token_expires_at || s.account.token_expires_at > Date.now()) return;
  if (!s.account.refresh) throw new Error('Connection expired');
  const p = providers[s.provider];
  const response = await providerFetch(p.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: s.account.refresh, client_id: env[`${p.prefix}_CLIENT_ID`], client_secret: env[`${p.prefix}_CLIENT_SECRET`],
  }) });
  if (!response.ok) throw new Error('Reconnect required');
  const tokens = await response.json();
  if (!tokens.access_token || String(tokens.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) < 120) throw new Error('Invalid token');
  s.account = { ...s.account, token: tokens.access_token, refresh: tokens.refresh_token || s.account.refresh, token_expires_at: Date.now() + (Number(tokens.expires_in) - 60) * 1000 };
  await env.DB.prepare('UPDATE email_sessions SET sealed = ? WHERE id = ?').bind(await seal(env, s.account, s.id), s.id).run();
}
async function cancelSession(env, id) {
  await env.DB.prepare("UPDATE email_followups SET status = 'cancelled', sealed = '', updated_at = ? WHERE session_id = ? AND status IN ('pending', 'queued', 'processing')").bind(Date.now(), id).run();
}
async function followupReceipt(env, id, requestId) {
  return env.DB.prepare('SELECT request_id, status, first_sent_at, due_at, updated_at FROM email_followups WHERE session_id = ? AND request_id = ?').bind(id, requestId).first();
}
// Atomic claims prevent overlapping cron invocations from submitting twice.
// Uncertain delivery is held for review, never retried. Cancel can win until the
// final send reservation; a request already in flight cannot be recalled.
export async function runEmailFollowups(env) {
  for (let i = 0; i < 25; i++) {
    const now = Date.now();
    const job = await env.DB.prepare("UPDATE email_followups SET status = 'processing', updated_at = ? WHERE rowid = (SELECT rowid FROM email_followups WHERE status = 'queued' AND due_at <= ? ORDER BY due_at LIMIT 1) AND status = 'queued' RETURNING *").bind(now, now).first();
    if (!job) break;
    let status = 'needs_attention';
    try {
      if (job.expires_at <= now || job.due_at < now - 2 * 86400000) throw new Error('Schedule expired');
      const s = await env.DB.prepare('SELECT * FROM email_sessions WHERE id = ? AND expires_at > ?').bind(job.session_id, now).first();
      if (!s || !configured(env, s.provider)) throw new Error('Reconnect required');
      s.account = await unseal(env, s.sealed, s.id);
      const message = await unseal(env, job.sealed, `${s.id}:${job.request_id}`);
      await refreshAccount(env, s);
      const reserved = await env.DB.prepare("UPDATE email_followups SET status = 'unknown', sealed = '', updated_at = ? WHERE session_id = ? AND request_id = ? AND status = 'processing' AND EXISTS (SELECT 1 FROM email_sessions WHERE id = ? AND expires_at > ?)")
        .bind(Date.now(), s.id, job.request_id, s.id, Date.now()).run();
      if (!reserved.meta?.changes) continue;
      status = 'unknown';
      status = await deliver(s, message);
    } catch { /* No provider errors or personal content in logs. */ }
    await env.DB.prepare("UPDATE email_followups SET status = ?, sealed = '', updated_at = ? WHERE session_id = ? AND request_id = ? AND status IN ('processing', 'unknown')")
      .bind(status, Date.now(), job.session_id, job.request_id).run();
  }
}
export async function emailRoute(request, env, readBody) {
  const url = new URL(request.url), route = url.pathname;
  if (request.method === 'GET' && route === '/api/email/status') {
    const available = Object.fromEntries(Object.keys(providers).map(p => [p, configured(env, p)]));
    const s = url.origin === origin(env) && Object.values(available).some(Boolean) ? await session(request, env) : null;
    return json({ providers: available, account: s ? { provider: s.provider, email: s.account.email, expires_at: s.expires_at, followups_enabled: Boolean(s.account.refresh) && env.LOCAL_DEVELOPMENT !== 'true', local_preview: env.LOCAL_DEVELOPMENT === 'true' } : null });
  }
  if (request.method === 'GET' && route === '/api/email/followups') {
    const s = url.origin === origin(env) ? await session(request, env) : null;
    if (!s) return json({ connected: false, jobs: [] });
    const result = await env.DB.prepare('SELECT request_id, status, first_sent_at, due_at, updated_at FROM email_followups WHERE (session_id = ? OR session_id IN (SELECT session_id FROM email_owners WHERE owner_hash = ?)) AND expires_at > ? ORDER BY due_at').bind(s.id, await ownerFor(env, s), Date.now()).all();
    return json({ connected: true, jobs: result.results });
  }
  if (request.method !== 'POST') fail(405, 'Use POST for email actions.');
  if (url.origin !== origin(env) || request.headers.get('Origin') !== url.origin) fail(403, 'Use the configured app address to connect or send email.');
  const body = await readBody(request);
  if (route === '/api/email/connect') {
    if (!body || Object.keys(body).some(k => !['provider', 'offline', 'expected_email'].includes(k)) || (body.offline !== undefined && typeof body.offline !== 'boolean') || (body.expected_email !== undefined && !email(body.expected_email))) fail(400, 'Choose an email provider and valid sending address.');
    return connect(request, env, body);
  }
  if (route === '/api/email/disconnect') {
    if (!body || Object.keys(body).length) fail(400, 'Unexpected request fields.');
    const token = readCookie(request, 'session');
    if (token) { await cancelSession(env, await digest(token)); await env.DB.prepare('DELETE FROM email_sessions WHERE id = ?').bind(await digest(token)).run(); }
    const pending = readCookie(request, 'oauth');
    if (pending) await env.DB.prepare('DELETE FROM email_oauth WHERE binding = ?').bind(await digest(pending)).run();
    const response = json({ ok: true }, { 'Set-Cookie': cookie(request, 'session', '', 0) });
    response.headers.append('Set-Cookie', cookie(request, 'oauth', '', 0));
    return response;
  }
  if (route === '/api/email/send') return send(request, env, body);
  if (route === '/api/email/cancel-followup') {
    if (!body || Object.keys(body).some(k => !['request_id', 'reason'].includes(k)) || !/^[a-f0-9-]{36}$/.test(body.request_id || '') || !['cancelled', 'replied', 'closed'].includes(body.reason)) fail(400, 'Choose a follow-up and reason.');
    const s = await session(request, env); if (!s) fail(401, 'Connect your account to manage follow-ups.');
    const row = await env.DB.prepare("UPDATE email_followups SET status = ?, sealed = '', updated_at = ? WHERE (session_id = ? OR session_id IN (SELECT session_id FROM email_owners WHERE owner_hash = ?)) AND request_id = ? AND status IN ('queued', 'processing', 'pending') RETURNING request_id")
      .bind(body.reason, Date.now(), s.id, await ownerFor(env, s), body.request_id).first();
    if (!row) fail(409, 'This follow-up has already finished or is being submitted. Check Sent mail.');
    return json({ ok: true });
  }
  fail(404, 'Email route not found.');
}
