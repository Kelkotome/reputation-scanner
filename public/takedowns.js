import { localApi, reportData, setChallengeHandler } from '/local-api.js?v=20261004-ai';
import { createBotCheck } from '/bot-check.js?v=20261004-ai';
import { requestAiConsent, aiDraftingAvailable, aiProviderName, AI_DRAFT_LABEL } from '/ai-draft.js?v=20261004-ai';
import { lookupReportingContact } from '/reporting-lookup.js?v=20260928-domain';
import { setupEmailSending } from '/email-send.js?v=20261101-simple';
import { stopItemFollowups, forgetRecordMetadata } from '/followup-control.js?v=20260930-sender';

const $ = (selector) => document.querySelector(selector);
const params = new URLSearchParams(location.hash.slice(1));
const legacyParams = new URLSearchParams(location.search);
for (const [key, value] of legacyParams) if (!params.has(key)) params.set(key, value);
if (legacyParams.has('id') || legacyParams.has('from_scan')) {
  const cleanUrl = new URL(location.href);
  cleanUrl.searchParams.delete('id');
  cleanUrl.searchParams.delete('from_scan');
  cleanUrl.hash = params.toString();
  history.replaceState(null, '', cleanUrl);
}
const caseId = params.get('id') || '';
const casePath = `/api/takedowns/${encodeURIComponent(caseId)}`;
const statusLabels = { ready: 'Ready to review', sent: 'Request sent', followed_up: 'Follow-up sent', removed: 'Removed', refused: 'Refused', escalated: 'Escalated' };
const finishedStatuses = new Set(['removed', 'refused', 'escalated']);
const drafts = new Map();
const draftSaves = new Map();
const draftFailures = new Set();
let caseData = null;
let activeItem = null;
let activeMode = 'initial';
let draftContact = '';
let originalReference = '';
let demo = params.get('demo') === '1';
let loading = false;
let lastLoaded = 0;
let pollTimer;
let stopped = false;
let lastRender = '';
const contactResult = document.createElement('p');
contactResult.className = 'hint'; contactResult.setAttribute('role', 'status');
$('#td-channel-instructions').after(contactResult);
const contactAction = document.createElement('button');
contactAction.type = 'button'; contactAction.className = 'button secondary'; contactAction.hidden = true;
contactResult.after(contactAction);
let escalation = null;
const escalationChoices = document.createElement('select'); escalationChoices.setAttribute('aria-label', 'Infrastructure escalation destination'); escalationChoices.hidden = true;
contactResult.after(escalationChoices);
let escalationContacts = [];
const emailField = document.createElement('div'); emailField.className = 'field';
emailField.innerHTML = '<label for="td-contact-email">Sending contact email</label><input id="td-contact-email" type="email" maxlength="254">';
$('#td-draft-subject').closest('.field').before(emailField);
// Opt-in AI drafting for one known URL, shown only when the server enables it.
setChallengeHandler(createBotCheck());
let aiSettings = null;
const aiRow = document.createElement('div'); aiRow.className = 'spacing-3';
const aiButton = document.createElement('button');
aiButton.type = 'button'; aiButton.id = 'td-ai-draft'; aiButton.className = 'button secondary'; aiButton.textContent = 'Draft with AI'; aiButton.hidden = true;
const aiLabel = document.createElement('div');
aiLabel.id = 'td-ai-label'; aiLabel.className = 'notice warn spacing-3'; aiLabel.setAttribute('role', 'status'); aiLabel.textContent = AI_DRAFT_LABEL; aiLabel.hidden = true;
aiRow.append(aiButton, aiLabel);
emailField.before(aiRow);
function showAiOption() {
  aiButton.hidden = !(aiDraftingAvailable(aiSettings) && activeMode === 'initial' && !demo && activeItem && !finishedStatuses.has(activeItem.status));
}
const emailSending = setupEmailSending({
  fields: { '#draft-email':'#td-contact-email', '#draft-subject':'#td-draft-subject', '#draft-body':'#td-draft-body', '#draft-accurate':'#td-accurate', '#draft-editor':'#td-draft-modal .modal-content', '#draft-modal':'#td-draft-modal' },
  canSchedule: () => activeMode === 'initial' && !activeItem?.sent_at,
  canSend: () => !demo && !finishedStatuses.has(activeItem?.status),
  context: () => ({record_id:caseId,hit_id:activeItem?.id,message_kind:activeMode}),
  beforeSend: () => activeMode === 'followup' ? stopItemFollowups(caseId, activeItem?.id, 'cancelled') : Promise.resolve(),
  onAccepted: async () => {
    if (!activeItem) return;
    await cacheDraft();
    await api(`${casePath}/items/${activeItem.id}`, {method:'PATCH',body:{status:activeMode === 'followup' ? 'followed_up' : 'sent',accuracy_confirmed:true}});
    $('#td-draft-feedback').textContent = 'Provider accepted your email. Delivery and removal are not confirmed.';
  },
});
$('#td-contact-email').addEventListener('input',()=>{
  const next=$('#td-contact-email').value.trim();
  if (draftContact) {
    const body=$('#td-draft-body');
    const updated=body.value.split('\n').map(line=>line===`Contact: ${draftContact}` ? `Contact: ${next || '[Your contact email]'}` : line).join('\n');
    if (updated!==body.value) { body.value=updated;body.dispatchEvent(new Event('input',{bubbles:true})); }
  }
  draftContact=next;
});
function chooseEscalation() {
  escalation = escalationContacts[Number(escalationChoices.value)] || null;
  emailSending.setChannel(escalation);
  if (escalation) contactResult.textContent = `${escalation.name}: ${escalation.email || escalation.form}. ${escalation.how}`;
  contactAction.hidden = !escalation;
  contactAction.textContent = escalation?.form ? 'Open infrastructure reporting form ↗' : 'Open email to selected escalation contact ↗';
}
escalationChoices.addEventListener('change', () => { chooseEscalation(); $('#td-accurate').checked = false; gateActions(); });
contactAction.addEventListener('click', () => {
  if (!$('#td-accurate').checked || !escalation) { contactResult.textContent = 'Review the draft and confirm its accuracy before using this reporting contact.'; return; }
  if (escalation.form) window.open(escalation.form, '_blank', 'noopener,noreferrer');
  else if (escalation.email) location.href = `mailto:${encodeURIComponent(escalation.email)}?subject=${encodeURIComponent($('#td-draft-subject').value)}&body=${encodeURIComponent($('#td-draft-body').value)}`;
});

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}
function message(target, text) { target.textContent = text || ''; target.hidden = !text; }
function busy(button, value, label = 'Please wait…') {
  if (value) { button.dataset.idleText = button.textContent; button.textContent = label; }
  else if (button.dataset.idleText) button.textContent = button.dataset.idleText;
  button.disabled = value;
}
function toast(text) {
  $('#td-toast').textContent = text;
  $('#td-toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('#td-toast').hidden = true; }, 5000);
}
function officialUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
async function api(path, { method = 'GET', body } = {}) {
  if (method === 'PATCH' && finishedStatuses.has(body?.status)) await stopItemFollowups(caseId, decodeURIComponent(path.split('/').pop()));
  if (method === 'PATCH' && body?.status === 'followed_up') await stopItemFollowups(caseId, decodeURIComponent(path.split('/').pop()), 'cancelled');
  if (method === 'DELETE') await stopItemFollowups(caseId);
  const result = await localApi(path, { method, body });
  if (method === 'DELETE') forgetRecordMetadata(caseId);
  return result;
}

function dateText(value) {
  if (!value) return 'Not recorded';
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
function localDateInput(timestamp = Date.now()) {
  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}
function isDue(item) {
  return !finishedStatuses.has(item.status) && item.status !== 'followed_up'
    && Boolean(item.sent_at) && (item.due === true || (Number(item.due_at) > 0 && Number(item.due_at) <= Date.now()));
}
function action(label, primary, callback) {
  const button = element('button', `button compact ${primary ? 'primary' : 'secondary'}`, label);
  button.type = 'button'; button.addEventListener('click', callback); return button;
}
function ageChanged() {
  const needsHelp = ['under18', 'unknown'].includes($('#td-age').value);
  $('#td-adult-fields').disabled = needsHelp;
  $('#td-adult-fields').hidden = needsHelp;
  $('#td-age-help').hidden = !needsHelp;
  $('#td-create-button').textContent = needsHelp ? 'Find specialist support →' : 'Organise my known URLs →';
}
function showHelpOnly(data) {
  $('#td-create').hidden = true;
  $('#td-demo-notice').hidden = true;
  $('#td-help-only').hidden = false;
  $('#td-help-reason').textContent = data.reason || 'When the person was under 18 at creation, or their age is uncertain, a specialist service can guide the next steps.';
  const cards = [];
  for (const link of data.links || []) {
    const href = officialUrl(link.url);
    if (!href) continue;
    const card = element('article', 'help-card td-help-card');
    const anchor = element('a', '', link.name || 'Support service');
    anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    card.append(anchor);
    if (link.detail) card.append(element('p', '', link.detail));
    cards.push(card);
  }
  $('#td-help-links').replaceChildren(...cards);
  $('#td-help-title').tabIndex = -1;
  $('#td-help-title').focus();
}

$('#td-age').addEventListener('change', ageChanged);
if (!caseId && params.get('from_scan')) {
  reportData('scan', params.get('from_scan')).then(record => {
    // Only prefill a name in this browser. No source pages, URLs or requests are sent.
    if (!$('#td-affected').value && record.name) $('#td-affected').value = record.name;
  }).catch(() => { /* A deleted or unavailable scan leaves a normal blank form. */ });
}
$('#td-fill-demo').addEventListener('click', () => {
  $('#td-age').value = 'adult';
  $('#td-urls').value = 'https://www.reddit.com/r/example/comments/demo_request\nhttps://publisher.example/post/demo-request';
  $('#td-affected').value = 'Alex Example';
  $('#td-reporter').value = 'Alex Example';
  $('#td-email').value = 'alex@example.com';
  $('#td-role').value = 'self';
  demo = true;
  $('#td-demo-notice').hidden = false;
  ageChanged();
  $('#td-urls').focus();
});
// Editing demo details must not silently turn fictional allegations into a real
// case. Start a new queue to leave demo mode.
$('#td-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const values = new FormData(form);
  const age = values.get('age_at_creation');
  const helpOnly = ['under18', 'unknown'].includes(age);
  const payload = { age_at_creation: age };
  message($('#td-error'), '');
  if (!helpOnly) {
    const urls = $('#td-urls').value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (!urls.length || urls.length > 25) { message($('#td-error'), 'Paste between 1 and 25 page addresses, one per line.'); return; }
    for (const url of urls) {
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.length > 2048) throw new Error();
      } catch { message($('#td-error'), 'Each address must be a valid http:// or https:// page URL without a username or password.'); return; }
    }
    Object.assign(payload, { urls, affected_name: values.get('affected_name').trim(), reporter_name: values.get('reporter_name').trim(),
      reporter_email: values.get('reporter_email').trim(), role: values.get('role'), authorised: values.has('authorised'),
      shared_without_consent: values.has('shared_without_consent'), is_demo: demo });
  }
  const button = $('#td-create-button');
  busy(button, true, helpOnly ? 'Finding support…' : 'Organising addresses…');
  try {
    const result = await api('/api/takedowns', { method: 'POST', body: payload });
    if (result.help_only) { showHelpOnly(result); return; }
    if (!result.id) throw new Error('The queue could not be opened. Please try again.');
    location.assign(`/takedowns.html#id=${encodeURIComponent(result.id)}${demo ? '&demo=1' : ''}`);
  } catch (error) { message($('#td-error'), error.message); }
  finally { busy(button, false); }
});

function itemCard(item) {
  const card = element('article', 'td-item');
  const top = element('div', 'card-top');
  top.append(element('strong', '', item.host || 'Known page address'));
  top.append(element('span', `pill${isDue(item) ? ' td-due' : finishedStatuses.has(item.status) ? ' td-terminal' : ''}`, isDue(item) ? 'Follow-up reminder due' : statusLabels[item.status] || 'Ready to review'));
  // Source URLs must remain text. Do not create links, embeds, previews or fetches from them.
  card.append(top, element('p', 'td-source-url', item.url));
  card.append(element('p', 'small', item.channel?.instructions || 'No verified reporting route is listed. Locate the website’s official reporting channel yourself; this tool does not open the source page.'));
  const dates = element('dl', 'td-date-list');
  const row = (label, value) => dates.append(element('dt', '', label), element('dd', '', value));
  if (item.sent_at) row('First sent', dateText(item.sent_at));
  if (item.due_at && !finishedStatuses.has(item.status) && item.status !== 'followed_up') row('Admin reminder', dateText(item.due_at));
  if (item.followed_up_at) row('Follow-up sent', dateText(item.followed_up_at));
  if (item.reference) row('Reference', item.reference);
  if (dates.childNodes.length) card.append(dates);
  const actions = element('div', 'card-actions');
  actions.append(action(item.sent_at ? 'Review original request' : 'Review request', !item.sent_at, () => openDraft(item, 'initial')));
  if (item.sent_at && !finishedStatuses.has(item.status)) actions.append(action('Prepare follow-up', true, () => openDraft(item, 'followup')));
  card.append(actions);
  const outcome = element('div', 'td-outcome');
  const label = element('label', '', 'Record an outcome');
  const select = element('select');
  select.id = `td-outcome-${String(item.id).replace(/[^a-z0-9_-]/gi, '')}`;
  label.htmlFor = select.id;
  const unchanged = element('option', '', statusLabels[item.status] || 'Ready to review');
  unchanged.value = ''; unchanged.disabled = true; unchanged.selected = true;
  select.append(unchanged);
  for (const status of ['removed', 'refused', 'escalated']) {
    if (status === item.status) continue;
    const option = element('option', '', statusLabels[status]); option.value = status; select.append(option);
  }
  select.addEventListener('change', async () => {
    select.disabled = true;
    try {
      await api(`${casePath}/items/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { status: select.value } });
      toast('Outcome saved. The follow-up reminder has been cleared.');
      await loadCase(true);
    } catch (error) { select.value = ''; toast(error.message); }
    finally { select.disabled = false; }
  });
  outcome.append(label, select); card.append(outcome);
  return card;
}
function renderQueue(data) {
  caseData = data;
  demo = data.is_demo === true || demo;
  $('#td-create').hidden = true;
  $('#td-queue').hidden = false;
  $('#td-demo-notice').hidden = !demo;
  $('#takedown-heading').textContent = 'Your known-URL request queue.';
  $('#takedown-intro').textContent = 'Review each draft, submit it yourself, then record the date and outcome here. Your source pages have not been fetched or verified.';
  const items = Array.isArray(data.items) ? data.items : [];
  const groups = new Map();
  for (const item of items) {
    const name = item.channel?.url ? (item.channel.name || item.host) : `${item.host || 'Website'} · route to locate`;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(item);
  }
  const due = items.filter(isDue).length;
  $('#td-queue-summary').textContent = `${items.length} ${items.length === 1 ? 'URL' : 'URLs'} · ${groups.size} reporting ${groups.size === 1 ? 'group' : 'groups'}${data.affected_name ? ` · ${data.affected_name}` : ''}`;
  $('#td-due-banner').textContent = due ? `${due} ${due === 1 ? 'request has a follow-up reminder' : 'requests have follow-up reminders'} due. Review the queue below. You choose whether and when to send a follow-up.`
    : 'No follow-up reminders are due. After you mark a request sent, a reminder appears 14 days after its original sent date.';
  $('#td-due-banner').classList.toggle('warn', due > 0);
  const support = [];
  for (const link of data.support_links || []) {
    const href = officialUrl(link.url);
    if (!href) continue;
    const entry = element('div', 'td-support-entry');
    const anchor = element('a', '', link.name || 'Official support');
    anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    entry.append(anchor);
    if (link.detail) entry.append(element('p', '', link.detail));
    support.push(entry);
  }
  $('#td-support').hidden = !support.length;
  $('#td-support-links').replaceChildren(...support);
  const key = JSON.stringify([items, due]);
  if (key === lastRender) return;
  lastRender = key;
  const sections = [];
  for (const [name, groupItems] of groups) {
    const section = element('section', 'td-group');
    const header = element('div', 'td-group-heading');
    header.append(element('h3', '', name), element('span', '', `${groupItems.length} ${groupItems.length === 1 ? 'URL' : 'URLs'}`));
    section.append(header, ...groupItems.map(itemCard)); sections.push(section);
  }
  $('#td-groups').replaceChildren(...sections);
}
async function loadCase(force = false) {
  if (stopped || loading || (!force && (document.hidden || $('#td-draft-modal').open || $('#td-delete-modal').open))) return;
  loading = true;
  try {
    const data = await api(casePath);
    if (stopped) return;
    lastLoaded = Date.now();
    renderQueue(data);
    message($('#td-error'), '');
  } catch (error) {
    message($('#td-error'), error.message);
    if (error.status === 404 || error.status === 410) {
      stopped = true; clearInterval(pollTimer); caseData = null; drafts.clear();
      $('#td-queue').hidden = true; $('#td-groups').replaceChildren();
      $('#takedown-heading').textContent = 'Queue not found in this browser.';
      $('#takedown-intro').textContent = 'Use the browser profile where this queue was saved. It may have been deleted or cleared with site data. Older server queues are not loaded here.';
    }
  } finally { loading = false; }
}
function cacheDraft() {
  if (!activeItem || stopped) return Promise.resolve();
  const itemId = activeItem.id;
  const mode = activeMode;
  const key = `${itemId}:${mode}`;
  const snapshot = { subject: $('#td-draft-subject').value, body: $('#td-draft-body').value };
  const previous = drafts.get(key);
  if (previous?.subject === snapshot.subject && previous?.body === snapshot.body && !draftFailures.has(key)) return draftSaves.get(key) || Promise.resolve();
  draftFailures.delete(key);
  drafts.set(key, snapshot);
  $('#td-draft-feedback').textContent = 'Saving your edits in this browser…';
  // Preserve input order so an older asynchronous save cannot replace a newer edit.
  const saving = (draftSaves.get(key) || Promise.resolve()).catch(() => {}).then(() =>
    api(`${casePath}/items/${encodeURIComponent(itemId)}/draft`, { method: 'PATCH', body: { mode, ...snapshot } }));
  draftSaves.set(key, saving);
  const isCurrent = () => activeItem?.id === itemId && activeMode === mode && drafts.get(key) === snapshot;
  saving.then(() => {
    if (isCurrent()) {
      message($('#td-draft-error'), '');
      $('#td-draft-feedback').textContent = 'Edits saved in this browser. Nothing has been sent.';
    }
  }, (error) => {
    if (draftSaves.get(key) === saving) draftFailures.add(key);
    if (isCurrent()) message($('#td-draft-error'), `Your latest edits could not be saved. Keep this page open and copy them before leaving. ${error.message || ''}`);
  });
  return saving;
}
function gateActions() {
  const reviewed = $('#td-accurate').checked;
  $('#td-copy').disabled = !reviewed;
  $('#td-open-form').disabled = !reviewed || !officialUrl(activeItem?.channel?.url);
  $('#td-mark-sent').disabled = !reviewed;
}
function openDraft(item, mode) {
  activeItem = item; activeMode = mode;
  $('#td-contact-email').value = caseData?.reporter_email || '';
  draftContact=$('#td-contact-email').value;
  emailSending.setChannel(item.channel?.url ? {name:item.channel.name,form:item.channel.url} : null);
  escalation = null; escalationChoices.hidden = true; contactAction.hidden = true; contactResult.textContent = '';
  if (!item.channel?.url && !demo) {
    contactResult.textContent = 'Checking domain-only public DNS and registration records for an escalation contact…';
    lookupReportingContact(item.url).then(result => {
      if (activeItem !== item) return;
      escalationContacts = result.contacts || [];
      escalationChoices.replaceChildren(...escalationContacts.map((contact, index) => {
        const option = document.createElement('option'); option.value = String(index); option.textContent = `${contact.name} — ${contact.kind}`; return option;
      }));
      escalationChoices.hidden = escalationContacts.length < 2;
      chooseEscalation();
      contactResult.textContent = escalation ? `${escalation.name}: ${escalation.email || escalation.form}. ${escalation.how}`
        : 'No usable contact could be established from public records. This site needs manual investigation; use the specialist support routes below.';
      contactAction.hidden = !escalation;
      contactAction.textContent = escalation?.form ? 'Open infrastructure reporting form ↗' : 'Open email to selected escalation contact ↗';
    }).catch(() => { if (activeItem === item) contactResult.textContent = 'Automatic contact lookup is unavailable. Use the specialist support routes for manual investigation.'; });
  }
  const followup = mode === 'followup';
  const saved = drafts.get(`${item.id}:${mode}`);
  aiLabel.hidden = !(mode === 'initial' && item.draft?.source === 'ai');
  showAiOption();
  localApi('/api/config').then(settings => { aiSettings = settings; if (activeItem === item) showAiOption(); }).catch(() => { aiSettings = null; showAiOption(); });
  $('#td-draft-title').textContent = followup ? 'Review your follow-up' : 'Review your request';
  $('#td-draft-url').textContent = item.url;
  $('#td-channel-name').textContent = item.channel?.name || 'Locate the official reporting route';
  $('#td-channel-instructions').textContent = item.channel?.instructions || 'No verified form is available for this host. Locate the website’s official reporting channel yourself. This tool will not fetch the source page.';
  $('#td-draft-subject').value = saved?.subject ?? (followup ? item.draft?.followup_subject : item.draft?.subject) ?? '';
  $('#td-draft-body').value = saved?.body ?? (followup ? item.draft?.followup_body : item.draft?.body) ?? '';
  if (!saved) drafts.set(`${item.id}:${mode}`, { subject: $('#td-draft-subject').value, body: $('#td-draft-body').value });
  originalReference = item.reference || '';
  $('#td-reference').value = originalReference;
  $('#td-sent-date-field').hidden = followup;
  $('#td-sent-date').value = localDateInput(item.sent_at || Date.now());
  $('#td-sent-date').max = localDateInput();
  $('#td-sent-date').disabled = Boolean(item.sent_at);
  $('#td-existing-sent').hidden = !item.sent_at;
  $('#td-existing-sent').textContent = item.sent_at ? `Originally sent ${dateText(item.sent_at)}. Saving sent details again will not move the original reminder date.` : '';
  $('#td-copy').textContent = followup ? 'Copy follow-up' : 'Copy request';
  $('#td-mark-sent').textContent = followup ? 'Mark follow-up as sent' : item.sent_at ? 'Save sent request details' : 'Mark request as sent';
  $('#td-mark-sent').hidden = finishedStatuses.has(item.status) || (!followup && item.status === 'followed_up');
  $('#td-open-form').hidden = !officialUrl(item.channel?.url);
  $('#td-modal-demo').hidden = !demo;
  $('#td-accurate').checked = false;
  $('#td-draft-feedback').textContent = draftFailures.has(`${item.id}:${mode}`)
    ? 'The latest edits have not been saved. Edit or close the draft to retry, or copy the text before leaving.'
    : 'Edits are saved in this browser as you type. Nothing is sent automatically.';
  message($('#td-draft-error'), '');
  gateActions();
  $('#td-draft-modal').showModal();
}
aiButton.addEventListener('click', async () => {
  if (!activeItem || activeMode !== 'initial' || demo || !aiDraftingAvailable(aiSettings)) return;
  const item = activeItem;
  const consent = await requestAiConsent({ providerName: aiProviderName(aiSettings), noun: 'link',
    subject: 'the link, the platform, the request type and anything you type below', requestLabel: 'Report intimate images shared without consent' });
  if (!consent || activeItem !== item || activeMode !== 'initial') return;
  busy(aiButton, true, 'Writing AI draft…');
  message($('#td-draft-error'), '');
  try {
    await cacheDraft();
    const result = await api(`${casePath}/items/${encodeURIComponent(item.id)}/draft-ai`, { method: 'POST', body: { consent: true, ...(consent.facts ? { facts: consent.facts } : {}) } });
    if (activeItem !== item || activeMode !== 'initial') return;
    $('#td-draft-subject').value = result.draft.subject;
    $('#td-draft-body').value = result.draft.body;
    drafts.set(`${item.id}:initial`, { subject: result.draft.subject, body: result.draft.body });
    item.draft = { ...item.draft, subject: result.draft.subject, body: result.draft.body, source: 'ai' };
    aiLabel.hidden = false;
    $('#td-accurate').checked = false; gateActions();
    $('#td-draft-feedback').textContent = 'AI draft saved in this browser only. Check every detail, replace any placeholders and edit it before sending. Nothing has been sent.';
    $('#td-draft-body').focus();
  } catch (error) {
    message($('#td-draft-error'), `${error.message || 'The AI draft could not be prepared.'}${/template/i.test(error.message || '') ? '' : ' Your template draft is unchanged.'}`);
  } finally { busy(aiButton, false); }
});
$('#td-draft-modal').addEventListener('close', cacheDraft);
$('#td-accurate').addEventListener('change', gateActions);
for (const id of ['td-draft-subject', 'td-draft-body']) $(`#${id}`).addEventListener('input', () => {
  cacheDraft(); $('#td-accurate').checked = false; gateActions();
});
$('#td-copy').addEventListener('click', async () => {
  if (!$('#td-accurate').checked) return;
  try {
    await navigator.clipboard.writeText(`Subject: ${$('#td-draft-subject').value}\n\n${$('#td-draft-body').value}`);
    $('#td-draft-feedback').textContent = activeMode === 'followup' ? 'Follow-up copied. Nothing has been sent.' : 'Request copied. Nothing has been sent.';
  } catch {
    $('#td-draft-body').focus(); $('#td-draft-body').select();
    $('#td-draft-feedback').textContent = 'Automatic copying is unavailable. Your message is selected so you can copy it manually.';
  }
});
$('#td-open-form').addEventListener('click', () => {
  const url = officialUrl(activeItem?.channel?.url);
  if ($('#td-accurate').checked && url) window.open(url, '_blank', 'noopener,noreferrer');
});
$('#td-mark-sent').addEventListener('click', async () => {
  if (!activeItem || !$('#td-accurate').checked) return;
  const itemId = activeItem.id;
  const mode = activeMode;
  const followup = activeMode === 'followup';
  const sentAt = activeItem.sent_at || new Date($('#td-sent-date').value).getTime();
  if (!followup && (!Number.isFinite(Number(sentAt)) || Number(sentAt) <= 0 || Number(sentAt) > Date.now())) {
    message($('#td-draft-error'), 'Enter the actual date and time you sent the request. It cannot be in the future.'); return;
  }
  const button = $('#td-mark-sent');
  const body = {
    status: followup ? 'followed_up' : 'sent', ...(!followup ? { sent_at: Number(sentAt) } : {}),
    ...($('#td-reference').value.trim() !== originalReference ? { reference: $('#td-reference').value.trim() } : {}),
    accuracy_confirmed: true,
  };
  busy(button, true, 'Saving…');
  message($('#td-draft-error'), '');
  try {
    await cacheDraft();
    await api(`${casePath}/items/${encodeURIComponent(itemId)}`, { method: 'PATCH', body });
    await loadCase(true);
    if (activeItem?.id === itemId && activeMode === mode) {
      const updated = caseData?.items?.find((item) => String(item.id) === String(itemId));
      if (updated) activeItem = updated;
      $('#td-draft-modal').close();
    }
    toast(followup ? 'Follow-up marked sent. The reminder is cleared.' : 'Sent date saved. The reminder uses the original date.');
  } catch (error) { message($('#td-draft-error'), error.message); }
  finally { busy(button, false); gateActions(); }
});
$('#td-delete').addEventListener('click', () => { message($('#td-delete-error'), ''); $('#td-delete-modal').showModal(); });
$('#td-confirm-delete').addEventListener('click', async () => {
  const button = $('#td-confirm-delete');
  busy(button, true, 'Deleting…');
  try {
    await api(casePath, { method: 'DELETE' });
    stopped = true; clearInterval(pollTimer); drafts.clear();
    location.replace('/takedowns.html#deleted=1');
  } catch (error) { message($('#td-delete-error'), error.message); busy(button, false); }
});

if (caseId) {
  $('#td-create').hidden = true;
  $('#takedown-heading').textContent = 'Opening your request queue…';
  loadCase(true);
  pollTimer = setInterval(() => loadCase(), 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastLoaded >= 60000) loadCase();
  });
} else if (params.get('deleted') === '1') toast('Your request queue has been deleted from this browser.');
window.addEventListener('pagehide', () => { stopped = true; clearInterval(pollTimer); });
window.addEventListener('pageshow', (event) => {
  if (event.persisted && caseId) { stopped = false; loadCase(true); pollTimer = setInterval(() => loadCase(), 60000); }
});
// Keep native GET submission unavailable if this module fails to initialise.
$('#td-create-button').disabled = false;
