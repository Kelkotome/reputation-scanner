const $ = (selector) => document.querySelector(selector);
const fields = ['scan_starts', 'search_attempts', 'search_successes', 'search_failures', 'estimated_search_cost_usd', 'in_tokens', 'out_tokens', 'tokens', 'ai_cost_usd'];
let authenticated = false;
let usage = null;
let period = 'today';
let generation = 0;
let loading = false;
let expiryTimer;

function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function message(text = '') { $('#admin-error').textContent = text; $('#admin-error').hidden = !text; }
function status(text) { $('#admin-status').textContent = text; }
function count(value) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value); }
function dollars(value) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value); }
function totals(value) {
  const result = {};
  for (const field of fields) {
    const number = value?.[field];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) throw new Error('Usage data is incomplete. Refresh to try again.');
    result[field] = number;
  }
  return result;
}
function sum(values) {
  return values.reduce((result, value) => {
    for (const field of fields) result[field] += value[field];
    return result;
  }, Object.fromEntries(fields.map((field) => [field, 0])));
}
function row(values, firstIsHeading = false) {
  const tr = element('tr');
  values.forEach((value, index) => {
    const cell = element(firstIsHeading && index === 0 ? 'th' : 'td', value);
    if (firstIsHeading && index === 0) cell.scope = 'row';
    tr.append(cell);
  });
  return tr;
}
async function api(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(response.status === 401 ? 'The access key or session is not valid.'
        : response.status === 429 ? 'Too many attempts. Wait a moment before trying again.'
          : response.status === 403 ? 'Admin sign-in through Cloudflare Access is required. Reload this page to sign in.'
          : response.status === 503 ? 'Operator access is not available. Check the server configuration.'
            : 'The request could not be completed. Please try again.');
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request timed out. Please try again.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function clearUsage() {
  usage = null;
  for (const id of ['admin-audience-rows', 'admin-daily-rows', 'admin-provider-rates', 'partner-rows']) $(`#${id}`).replaceChildren();
  for (const id of ['metric-scans', 'metric-requests', 'metric-cost', 'metric-ai-tokens', 'metric-outcomes', 'metric-ai-cost']) $(`#${id}`).textContent = '—';
  $('#admin-updated').textContent = '';
  $('#admin-expiry').textContent = '';
}
function lock(text = 'Sign in to view internal usage.', retryLogout = false) {
  generation++;
  authenticated = false;
  loading = false;
  clearTimeout(expiryTimer);
  clearUsage();
  $('#admin-dashboard').hidden = true;
  $('#admin-login-panel').hidden = false;
  $('#admin-access-key').value = '';
  $('#admin-login-button').disabled = retryLogout;
  $('#admin-login-button').textContent = 'Sign in →';
  $('#admin-logout').hidden = !retryLogout;
  $('#admin-logout').disabled = false;
  $('#admin-logout').textContent = retryLogout ? 'Retry sign out' : 'Sign out';
  status(text);
}
function unlock(session) {
  if (session.operator !== true || !Number.isFinite(Number(session.expires_at)) || Number(session.expires_at) <= Date.now()) {
    lock('Your session has expired. Sign in again.'); return false;
  }
  generation++;
  authenticated = true;
  $('#admin-login-panel').hidden = true;
  $('#admin-dashboard').hidden = false;
  $('#admin-logout').hidden = false;
  $('#admin-logout').disabled = false;
  $('#admin-logout').textContent = 'Sign out';
  const expires = new Date(Number(session.expires_at));
  $('#admin-expiry').textContent = `Session ends ${expires.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} (your local time).`;
  clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => { lock('Your session has expired. Sign in again.'); }, Math.min(2147483647, expires.getTime() - Date.now()));
  return true;
}
function normalise(data) {
  if (!data || !Array.isArray(data.days) || !Array.isArray(data.providers) || !/^\d{4}-\d{2}-\d{2}$/.test(data.today?.date)) throw new Error('Usage data is incomplete. Refresh to try again.');
  const parseDay = (day) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date)) throw new Error('Usage dates could not be read.');
    return { date: day.date, public: totals(day.public), operator: totals(day.operator) };
  };
  const providers = data.providers.map((provider) => {
    const rate = Number(provider.cost_per_1000_queries);
    if (!Number.isFinite(rate) || rate < 0) throw new Error('A configured search rate could not be read.');
    const source = String(provider.provider || 'Unspecified provider');
    const names = { searxng: 'SearXNG', serpapi: 'SerpApi', serper: 'Serper', brave: 'Brave' };
    const role = provider.role === 'backup' ? 'backup' : 'primary';
    const dailyLimit = provider.daily_query_limit === undefined ? null : provider.daily_query_limit;
    if (dailyLimit !== null && (!Number.isSafeInteger(dailyLimit) || dailyLimit < 0)) throw new Error('A configured provider limit could not be read.');
    const estimateSupplied = provider.estimate_supplied !== false && (role !== 'backup' || rate > 0);
    const estimateNotice = typeof provider.estimate_notice === 'string' ? provider.estimate_notice.slice(0, 500)
      : role === 'backup' ? estimateSupplied ? 'Configured estimate; actual provider billing may differ.'
        : 'No cost estimate supplied. Check the provider’s billing before relying on these totals.' : '';
    return { name: Object.hasOwn(names, source) ? names[source] : source, rate, role, dailyLimit, estimateSupplied, estimateNotice };
  });
  return { ...data, today: parseDay(data.today), days: data.days.map(parseDay).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30), providers };
}
function renderPeriod() {
  if (!usage) return;
  const days = period === 'today' ? [usage.today] : usage.days;
  const publicTotals = sum(days.map((day) => day.public));
  const operatorTotals = sum(days.map((day) => day.operator));
  const combined = sum([publicTotals, operatorTotals]);
  $('#admin-usage-title').textContent = period === 'today' ? 'Today’s usage' : 'Last 30 days’ usage';
  $('#admin-period-detail').textContent = period === 'today' ? `${usage.today.date} · UTC day` : 'Available daily counters from the last 30 days · UTC dates';
  for (const button of document.querySelectorAll('[data-period]')) button.setAttribute('aria-pressed', String(button.dataset.period === period));
  $('#metric-scans').textContent = count(combined.scan_starts);
  $('#metric-requests').textContent = count(combined.search_attempts);
  $('#metric-outcomes').textContent = `${count(combined.search_successes)} succeeded · ${count(combined.search_failures)} failed`;
  $('#metric-cost').textContent = dollars(combined.estimated_search_cost_usd);
  $('#metric-ai-tokens').textContent = count(combined.tokens);
  $('#metric-ai-cost').textContent = `${dollars(combined.ai_cost_usd)} AI cost`;
  $('#admin-audience-rows').replaceChildren(...[['Public', publicTotals], ['Operator', operatorTotals]].map(([name, value]) => row([
    name, count(value.scan_starts), count(value.search_attempts), count(value.search_successes), count(value.search_failures),
    dollars(value.estimated_search_cost_usd), `${count(value.in_tokens)} / ${count(value.out_tokens)}`, dollars(value.ai_cost_usd),
  ], true)));
}
function renderUsage() {
  renderPeriod();
  $('#admin-daily-rows').replaceChildren(...usage.days.map((day) => {
    const combined = sum([day.public, day.operator]);
    return row([day.date, count(day.public.scan_starts), count(day.operator.scan_starts), count(combined.search_attempts), count(combined.search_successes), count(combined.search_failures), dollars(combined.estimated_search_cost_usd)], true);
  }));
  $('#admin-history-empty').hidden = usage.days.length > 0;
  $('#admin-provider-rates').replaceChildren(...usage.providers.map((provider) => {
    const item = element('li'), detail = element('div');
    detail.append(element('span', provider.estimateSupplied ? `${dollars(provider.rate)} / 1,000` : 'Estimate not supplied'));
    if (provider.role === 'backup' && provider.dailyLimit !== null) {
      const cap = element('p', `Daily backup cap: ${count(provider.dailyLimit)} attempted requests across public and operator use (UTC).`);
      cap.className = 'hint'; detail.append(cap);
    }
    if (provider.estimateNotice) {
      const notice = element('p', provider.estimateNotice); notice.className = 'hint'; detail.append(notice);
    }
    item.append(element('strong', `${provider.name}${provider.role === 'backup' ? ' backup' : ''}`), detail);
    return item;
  }));
  if (!usage.providers.length) $('#admin-provider-rates').append(element('li', 'No configured search rates were returned.'));
  const publicLimit = Number(usage.public_daily_limit);
  $('#admin-allowance').textContent = `Operator scans have no daily scan limit. Public access allows ${Number.isFinite(publicLimit) ? count(publicLimit) : '3'} scans per IP address per UTC day. Per-scan and provider safeguards still apply.`;
  $('#admin-retention').textContent = `${Number(usage.retention_days) || 30} days of aggregate counters · UTC`;
  const aiOff = usage.cloud_ai_enabled === false;
  const drafting = usage.ai_drafting && typeof usage.ai_drafting === 'object' ? usage.ai_drafting : null;
  if (aiOff && drafting?.enabled === true) {
    const today = drafting.today || {};
    const spent = Number(today.cost_usd) || 0, limit = Number(drafting.daily_usd_limit);
    $('#admin-ai-heading').textContent = 'Opt-in AI drafting is on';
    $('#admin-ai-copy').textContent = `Visitors can choose “Draft with AI” for one result at a time (${String(drafting.provider || 'provider')}, ${String(drafting.model || 'model')}). Today: ${count(Number(today.requests) || 0)} AI drafts requested, ${count(Number(today.failures) || 0)} failed, estimated US$${spent.toFixed(4)}${Number.isFinite(limit) ? ` of the US$${limit.toFixed(2)} daily budget` : ''}. Estimates come from reported token usage, not the provider invoice. Prompts and drafts are not stored. Matching and templates still run in the browser.`;
  } else {
    $('#admin-ai-heading').textContent = aiOff ? 'No cloud AI is enabled' : 'Cloud AI status';
    $('#admin-ai-copy').textContent = aiOff ? 'No cloud AI is enabled; no AI tokens are used by this app. Matching rules and request templates run in the browser.' : 'The server did not confirm that cloud AI is disabled. Review its configuration and the token counters below.';
  }
  $('#admin-updated').textContent = `Updated ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} (your local time).`;
}
async function loadUsage() {
  if (!authenticated || loading) return;
  const request = generation;
  loading = true;
  $('#admin-refresh').disabled = true;
  $('#admin-refresh').textContent = 'Refreshing…';
  message(); status('Loading aggregate usage…');
  try {
    const result = await api('/api/operator/usage');
    if (!authenticated || request !== generation) return;
    usage = normalise(result);
    renderUsage(); status('Operator session active. Usage is visible only after server authentication.');
  } catch (error) {
    if (request !== generation) return;
    if (error.status === 401) lock('Your session is no longer valid. Sign in again.');
    else { message(error.message || 'Usage could not be loaded.'); status('Usage could not be refreshed. Previously loaded counters may be out of date.'); }
  } finally {
    if (request === generation) loading = false;
    $('#admin-refresh').disabled = false;
    $('#admin-refresh').textContent = 'Refresh';
  }
}
async function checkSession() {
  lock('Checking your operator session…');
  $('#admin-login-button').disabled = true;
  const request = generation;
  try {
    const session = await api('/api/operator/session');
    if (request !== generation) return;
    if (session.operator === true && unlock(session)) { await loadUsage(); await loadPartners(); }
    else lock();
  } catch (error) {
    if (request !== generation) return;
    lock('Session could not be checked. You can try signing in.');
    if (error.status !== 401) message(error.message || 'Session could not be checked.');
  }
}

$('#admin-login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const input = $('#admin-access-key');
  const button = $('#admin-login-button');
  button.disabled = true; button.textContent = 'Signing in…'; message();
  const request = ++generation;
  try {
    const pending = api('/api/operator/login', { method: 'POST', body: { access_key: input.value } });
    input.value = '';
    const session = await pending;
    if (request !== generation) return;
    if (unlock(session)) { $('#admin-access-title').focus(); await loadUsage(); await loadPartners(); }
  } catch (error) {
    if (request !== generation) return;
    lock('Sign in to view internal usage.');
    message(error.status === 401 ? 'The access key was not accepted. Check it and try again.' : error.message || 'Sign-in failed.');
    input.focus();
  } finally {
    input.value = '';
    button.disabled = !authenticated && !$('#admin-logout').hidden;
    button.textContent = 'Sign in →';
  }
});
$('#admin-logout').addEventListener('click', async () => {
  lock('Signing out…', true);
  $('#admin-logout').disabled = true; message();
  const request = generation;
  try {
    await api('/api/operator/logout', { method: 'POST', body: {} });
    if (request !== generation) return;
    lock('You are signed out.'); $('#admin-access-key').focus();
  } catch (error) {
    if (request !== generation) return;
    lock('The server session may still be active. Retry sign out before leaving a shared device.', true);
    message(error.message || 'Sign-out failed.');
  }
});
let partnerLoading = false;
function formatTime(value) { return Number.isFinite(Number(value)) && value ? new Date(Number(value)).toLocaleString() : 'Never'; }
function partnerMessage(text) { $('#partner-message').textContent = text; }
function renderPartners(list) {
  const rows = list.map((partner) => {
    const tr = row([partner.email, partner.organisation || '—', count(partner.daily_limit), count(partner.scans_today), count(partner.scans_30_days), formatTime(partner.last_login_at)], true);
    const cell = element('td'), remove = element('button', 'Remove');
    remove.type = 'button'; remove.className = 'button secondary compact';
    remove.addEventListener('click', async () => {
      if (remove.dataset.confirm !== 'yes') { remove.dataset.confirm = 'yes'; remove.textContent = 'Confirm remove'; return; }
      remove.disabled = true;
      try { await api('/api/operator/partners/remove', { method: 'POST', body: { email: partner.email } }); partnerMessage(`Removed ${partner.email}. Their sessions have ended.`); await loadPartners(); }
      catch (error) { remove.disabled = false; partnerMessage(error.message || 'The partner could not be removed.'); }
    });
    cell.append(remove); tr.append(cell);
    return tr;
  });
  $('#partner-rows').replaceChildren(...rows);
  $('#partners-empty').hidden = rows.length > 0;
}
async function loadPartners() {
  if (!authenticated || partnerLoading) return;
  partnerLoading = true;
  try {
    const result = await api('/api/operator/partners');
    if (!authenticated) return;
    if (Number.isSafeInteger(result.default_daily_limit) && !$('#partner-email').value) $('#partner-limit').value = String(result.default_daily_limit);
    renderPartners(Array.isArray(result.partners) ? result.partners : []);
  } catch (error) {
    if (error.status === 401) lock('Your session is no longer valid. Sign in again.');
    else partnerMessage(error.status === 403 ? 'Partner management needs the admin Cloudflare Access sign-in. Reload this page.' : error.message || 'Partners could not be loaded.');
  } finally { partnerLoading = false; }
}
$('#partner-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const button = $('#partner-save'); button.disabled = true;
  const email = $('#partner-email').value.trim();
  try {
    await api('/api/operator/partners', { method: 'POST', body: { email, organisation: $('#partner-org').value.trim(), daily_limit: Number($('#partner-limit').value) } });
    partnerMessage(`Saved ${email.toLowerCase()}. Send them the sign-in link: ${location.origin}/partner.html`);
    $('#partner-email').value = ''; $('#partner-org').value = '';
    await loadPartners();
  } catch (error) { partnerMessage(error.status === 400 ? 'Check the email, organisation and daily scans (1–500).' : error.message || 'The partner could not be saved.'); }
  finally { button.disabled = false; }
});
$('#partners-refresh').addEventListener('click', loadPartners);
$('#admin-refresh').addEventListener('click', loadUsage);
for (const button of document.querySelectorAll('[data-period]')) button.addEventListener('click', () => { period = button.dataset.period === 'month' ? 'month' : 'today'; renderPeriod(); });
window.addEventListener('pagehide', () => { lock(); });
window.addEventListener('pageshow', (event) => { if (event.persisted) checkSession(); });
checkSession();
