import { localApi, listSaved, clearLocalData, assistancePreview, setChallengeHandler } from '/local-api.js?v=20261004-ai';
import { searchCoverageView, liveSearchConsentView, aiDraftingNotice } from '/search-coverage.js?v=20261004-ai';
import { requestAiConsent, aiDraftingAvailable, aiProviderName, AI_DRAFT_LABEL } from '/ai-draft.js?v=20261004-ai';
import { createBotCheck } from '/bot-check.js?v=20261004-ai';
import { additionalResultPreview } from '/result-preview.js?v=20260927-contact';
import { resultLabelView } from '/result-labels.js?v=20261001-labels';
import { setupEmailSending } from '/email-send.js?v=20261101-simple';
import { lookupReportingContact } from '/reporting-lookup.js?v=20260928-domain';
import { stopItemFollowups, forgetRecordMetadata } from '/followup-control.js?v=20260930-sender';

const $ = (selector, root = document) => root.querySelector(selector);
const page = document.body.dataset.page;
const params = new URLSearchParams(location.hash.slice(1));
const legacyParams = new URLSearchParams(location.search);
for (const [key, value] of legacyParams) if (!params.has(key)) params.set(key, value);
// Older links are read locally; all new record links keep identifiers out of HTTP URLs.
if (['id', 'scan_id', 'hit_id'].some((key) => legacyParams.has(key))) {
  const cleanUrl = new URL(location.href);
  for (const key of ['id', 'scan_id', 'hit_id']) cleanUrl.searchParams.delete(key);
  cleanUrl.hash = params.toString();
  history.replaceState(null, '', cleanUrl);
}
const scanId = params.get('id') || params.get('scan_id') || '';
const scanPath = () => `/api/scan/${encodeURIComponent(scanId)}`;
const reportUrl = (id) => `/report.html#id=${encodeURIComponent(id)}`;
const contactUrl = (type = 'help', hitId) => {
  const query = new URLSearchParams({ type });
  if (scanId) query.set('scan_id', scanId);
  if (hitId) query.set('hit_id', hitId);
  return `/contact.html#${query}`;
};
// Registration does not load Cloudflare. The widget loads only on demand after
// a consented operation and a server configuration requiring the check.
setChallengeHandler(createBotCheck());
const categoryLabels = {
  scam_fraud: 'Scam / fraud accusation', crime_legal: 'Crime or court mention',
  defamation_accusation: 'Accusation / call-out', doxxing_personal_info: 'Personal information',
  harassment: 'Harassment', negative_news_forum: 'Review, news or forum post',
  same_name_other_person: 'Possible different person', neutral: 'Other mention',
};
const statusLabels = {
  new: 'Not reviewed', found: 'Not reviewed', drafted: 'Draft prepared', pending: 'Not reviewed', unreviewed: 'Not reviewed',
  not_me: 'Not me', resolved: 'Resolved', sent: 'Request sent', removed: 'Removed',
  refused: 'Request refused', escalated: 'Escalated',
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
function showError(target, message) {
  target.textContent = message || '';
  target.hidden = !message;
}
async function api(path, { method = 'GET', body, scoped = false } = {}) {
  if (method === 'PATCH' && ['removed','resolved','refused','escalated','not_me'].includes(body?.status)) await stopItemFollowups(scanId, decodeURIComponent(path.split('/').pop()));
  if (method === 'DELETE' && path.startsWith('/api/scan/')) await stopItemFollowups(scanId);
  const result = await localApi(path, { method, body, ...(scoped ? { scanId } : {}) });
  if (method === 'DELETE' && path.startsWith('/api/scan/')) forgetRecordMetadata(scanId);
  return result;
}

function busy(button, working, label) {
  if (working) {
    button.dataset.originalText = button.textContent;
    button.textContent = label || 'Please wait…';
  } else if (button.dataset.originalText) button.textContent = button.dataset.originalText;
  button.disabled = working;
}
function toast(message) {
  const target = $('#toast');
  if (!target) return;
  target.textContent = message;
  target.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { target.hidden = true; }, 4500);
}
function list(value) { return String(value || '').split(/[,\n]/).map((item) => item.trim()).filter(Boolean); }
function openExternal(url) {
  const validated = safeUrl(url);
  if (validated) window.open(validated, '_blank', 'noopener,noreferrer');
}

document.querySelectorAll('[data-close]').forEach((button) => {
  button.addEventListener('click', () => document.getElementById(button.dataset.close)?.close());
});

if (page === 'index') {
  const form = $('#scan-form');
  const button = $('#start-button');
  let currentSubjectType = 'person';
  let scanConfig = null;
  let submitting = false;
  const supportConsentNotice = node('div', 'notice spacing-4', 'Your selections use specialist support instead of a live search. Search consent is not needed and no search queries will be sent. Use “Find specialist support” below.');
  supportConsentNotice.id = 'support-consent-notice';
  supportConsentNotice.setAttribute('role', 'status');
  supportConsentNotice.hidden = true;
  $('#live-search-consent-row').before(supportConsentNotice);
  $('#live-search-consent').checked = false;
  const personalSafetyTypes = ['doxxing_personal_info', 'sensitive_intimate', 'child_safety'];
  const hasPersonalSafetySelection = () => $('#is-minor').checked || [...form.querySelectorAll('[name=harm_types]:checked')]
    .some((input) => personalSafetyTypes.includes(input.value));
  function updateStartLabel() {
    if (submitting) return;
    const sensitive = [...form.querySelectorAll('[name=harm_types]:checked')]
      .some((input) => ['sensitive_intimate', 'child_safety'].includes(input.value));
    const live = scanConfig && !scanConfig.demo && scanConfig.provider !== 'session';
    $('#live-search-consent-row').hidden = !live || sensitive;
    supportConsentNotice.hidden = !sensitive;
    $('#live-search-consent').required = Boolean(live && !sensitive);
    $('#live-search-consent').disabled = !live || sensitive;
    button.disabled = !sensitive && (!scanConfig || (live && (!scanConfig.search_relay_enabled || !$('#live-search-consent').checked
      || (scanConfig.bot_check_required && !scanConfig.bot_check_configured))));
    button.textContent = sensitive ? 'Find specialist support →'
      : currentSubjectType === 'business' ? 'Start our business scan →' : 'Start my free scan →';
  }
  function setSubjectType(requestedType) {
    let type = requestedType === 'business' ? 'business' : 'person';
    // Keep existing personal safety choices visible and intact until the user resolves them.
    const blocked = type === 'business' && hasPersonalSafetySelection();
    if (blocked) type = 'person';
    $('#subject-safety-notice').hidden = !blocked;
    $(`[name=subject_type][value=${type}]`, form).checked = true;
    const business = type === 'business';
    if (type !== currentSubjectType) $('[name=attestation]', form).checked = false;
    currentSubjectType = type;
    $('#business-details').hidden = !business;
    for (const input of $('#business-details').querySelectorAll('input')) input.disabled = !business;
    $('#representative-name').required = business;
    for (const group of form.querySelectorAll('[data-person-only]')) {
      group.hidden = business;
      for (const input of group.querySelectorAll('input')) input.disabled = business;
    }
    $('#start-title').textContent = business ? 'Start with your business' : 'Start with your name';
    $('#full-name-label').textContent = business ? 'Business name *' : 'Full name *';
    $('#full-name').placeholder = business ? 'Your business or trading name' : 'Your name as it appears online';
    $('#full-name').autocomplete = business ? 'organization' : 'name';
    $('#full-name-hint').textContent = business
      ? 'Use the name customers know. Only scan a business you own or are authorised to represent.'
      : 'Search for yourself, or for a child in your care.';
    $('#aliases-label').replaceChildren(document.createTextNode(business ? 'Trading or previous names ' : 'Other names '), node('span', 'optional', '(optional)'));
    $('#aliases-hint').textContent = business ? 'Other trading names, former business names or spelling variations.' : 'Previous names, nicknames or spelling variations.';
    $('#attestation-copy').textContent = business
      ? 'I own this business or am authorised to represent it and prepare requests on its behalf. *'
      : 'I am searching for myself, or I am the parent/guardian of the person. *';
    $('#harm-safety-hint').textContent = business
      ? 'For personal information, under-18 or intimate-content concerns, choose an individual scan or visit Safety & support.'
      : 'For intimate-image or child-safety concerns, we will take you to specialist support without searching.';
    updateStartLabel();
    return !blocked;
  }
  setSubjectType($('[name=subject_type]:checked', form)?.value);
  function showScanConfig(config) {
    const consentView = liveSearchConsentView(config);
    if (scanConfig && liveSearchConsentView(scanConfig).scope !== consentView.scope) $('#live-search-consent').checked = false;
    scanConfig = config;
    const live = !config.demo && config.provider !== 'session';
    const selfHosted = config.provider === 'searxng';
    $('#local-demo-notice').hidden = !config.demo;
    $('#live-search-consent-row').hidden = !live;
    $('#scan-allowance').hidden = !live;
    $('#scan-allowance').textContent = config.partner
      ? `Partner access (${config.partner.email}): ${Number(config.partner.remaining_scans) || 0} of ${Number(config.partner.daily_limit) || 50} scans left today, resetting at 00:00 UTC. Each scan has up to ${Number(config.max_queries) || 12} search queries. Your saved scans remain in this browser.`
      : config.operator
      ? `Operator access: unlimited daily scan starts, with up to ${Number(config.max_queries) || 60} search queries per scan. Your saved scans remain in this browser.`
      : `Public live scans: ${Number(config.public_daily_limit) || 3} per IP address per day, resetting at 00:00 UTC. People on the same network share this allowance. Each scan has up to ${Number(config.max_queries) || 12} search queries and uses a slot when its first search starts. Retries with the same valid permit do not use another daily slot.`;
    $('#bot-check-notice').textContent = config.bot_check_required
      ? config.bot_check_configured ? 'A Cloudflare security check is required when starting a public scan. It processes your IP address and browser signals.'
        : 'The required security check is unavailable. Public live searches cannot start until it is configured.'
      : config.abuse_protection_enabled ? 'Public requests are rate limited to protect the service. A security check may be required on the hosted site.' : '';
    $('#country-hint').textContent = selfHosted || config.search_country_supported === false
      ? 'Used only to help match identities in this browser. This search does not filter results by country or region.'
      : 'Helps prioritise results from this country or region and distinguish similar names.';
    $('#live-search-consent-copy').textContent = consentView.consentCopy;
    $('#search-privacy').textContent = consentView.privacyText;
    $('#cloud-ai-privacy').textContent = aiDraftingNotice(config);
    const settings = $('#live-search-settings');
    settings.classList.toggle('warn', live && !config.search_relay_enabled);
    settings.textContent = config.demo
      ? 'Demo mode uses fictional results and saves them in this browser. No live search is sent.'
      : config.provider === 'session'
        ? 'Queries are prepared in this browser for manual export and import. No live search is sent automatically.'
      : config.search_relay_enabled
        ? selfHosted
          ? `Live search uses our self-hosted SearXNG service after your consent. Names and context in queries reach its external search engines.${consentView.backupProvider ? ' SerpApi can provide Google web results when SearXNG supplies no usable Google listings, under the same explicit consent.' : ''} Country stays local for identity matching; autocomplete is unavailable.`
          : 'Live search is available after your consent below. Names and context included in search queries leave this browser; full scan records stay here.'
        : 'Live search is unavailable because the search relay is disabled. You can still organise known URLs, open saved records and use safety support.';
    updateStartLabel();
  }
  function refreshScanConfig() {
    return api('/api/config').then(showScanConfig).catch(() => {
      scanConfig = null;
      $('#live-search-settings').textContent = 'Search settings could not be loaded. Reload to try again. Known-URL queues and safety support remain available.';
      updateStartLabel();
    });
  }
  refreshScanConfig();
  window.addEventListener('focus', refreshScanConfig);
  form.addEventListener('change', (event) => {
    if (event.target.name === 'subject_type') setSubjectType(event.target.value);
    else updateStartLabel();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const business = $('[name=subject_type]:checked', form)?.value === 'business';
    if (business && hasPersonalSafetySelection()) {
      setSubjectType('business');
      $('#subject-safety-notice').scrollIntoView({ block: 'center' });
      return;
    }
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const harmTypes = data.getAll('harm_types');
    const isMinor = !business && data.has('is_minor');
    // Sensitive cases leave the form without transmitting names or initiating any search.
    if (harmTypes.some((type) => ['sensitive_intimate', 'child_safety'].includes(type))) {
      location.assign(`/help.html#sensitive=1${isMinor ? '&minor=1' : ''}`);
      return;
    }
    showError($('#form-error'), '');
    if (!scanConfig || (!scanConfig.demo && scanConfig.provider !== 'session' && (!scanConfig.search_relay_enabled || !data.has('live_search_consent')))) {
      showError($('#form-error'), 'Live search needs an enabled relay and your explicit consent. You can still organise known URLs locally.');
      updateStartLabel();
      return;
    }
    const textValue = (key) => String(data.get(key) || '').trim();
    if (business && textValue('website') && !safeUrl(textValue('website'))) {
      showError($('#form-error'), 'Enter a full http:// or https:// business website address without a username or password.');
      $('#business-website').focus();
      return;
    }
    for (const [key, label] of [['variants', 'other names'], ['usernames', 'usernames']]) {
      const values = list(data.get(key));
      if (values.length > 5 || values.some((value) => value.length > 80)) {
        showError($('#form-error'), `Enter up to 5 ${label}, with at most 80 characters each.`);
        return;
      }
    }
    submitting = true;
    busy(button, true, 'Preparing your scan…');
    try {
      const result = await api('/api/scan', { method: 'POST', body: {
        subject_type: business ? 'business' : 'person',
        full_name: data.get('full_name').trim(), variants: list(data.get('variants')),
        context: { country_code: textValue('country_code'), city: textValue('city'),
          usernames: list(data.get('usernames')),
          ...(business ? { representative_name: textValue('representative_name'), website: textValue('website'), industry: textValue('industry') }
            : { employer: textValue('employer'), school: textValue('school') }) },
        email: data.get('email').trim(), is_minor: isMinor, harm_types: harmTypes,
        attestation: data.has('attestation'),
        live_search_consent: data.has('live_search_consent'),
        ...(data.has('live_search_consent') && liveSearchConsentView(scanConfig).backupProvider === 'serpapi'
          ? { google_backup_consent: true } : {}),
      } });
      if (result.help_only) {
        location.assign(`/help.html#sensitive=1${isMinor ? '&minor=1' : ''}`);
      } else if (!result.id) throw new Error('The scan could not be opened. Please try again.');
      else if (result.show_help_first || isMinor) location.assign(`/help.html#minor=1&id=${encodeURIComponent(result.id)}`);
      else location.assign(reportUrl(result.id));
    } catch (error) { showError($('#form-error'), error.message); submitting = false; busy(button, false); updateStartLabel(); }
  });

  async function refreshSaved() {
    const status = $('#saved-records-status');
    const clearButton = $('#clear-local-data');
    try {
      const saved = await listSaved();
      $('#saved-records-list').replaceChildren(...saved.map((record) => {
        const item = node('li', 'saved-record');
        const link = node('a', '', record.label || (record.kind === 'case' ? 'Removal request queue' : 'Reputation scan'));
        link.href = record.kind === 'case' ? `/takedowns.html#id=${encodeURIComponent(record.id)}` : reportUrl(record.id);
        const date = new Date(record.created_at);
        const detail = `${record.kind === 'case' ? 'URL queue' : 'Scan'} · ${Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
        item.append(link, node('span', 'hint', detail));
        return item;
      }));
      status.textContent = saved.length ? `${saved.length} ${saved.length === 1 ? 'record' : 'records'} saved in this browser profile.` : 'No scans or queues are saved in this browser yet.';
      clearButton.disabled = saved.length === 0;
    } catch (error) {
      status.textContent = error.message || 'This browser could not open local storage. Enable site storage to save records.';
      clearButton.disabled = true;
    }
  }
  $('#clear-local-data').addEventListener('click', async () => {
    if (!window.confirm('Delete every toolkit scan, result, draft, queue and reminder saved in this browser? This cannot be undone. It does not withdraw assistance requests or reports you already sent.')) return;
    busy($('#clear-local-data'), true, 'Clearing…');
    try {
      const saved = await listSaved();
      for (const record of saved) await stopItemFollowups(record.id);
      await clearLocalData();
      for (const record of saved) forgetRecordMetadata(record.id);
      for (const key of Object.keys(localStorage)) if (key.startsWith('rep-report-notes:')) localStorage.removeItem(key);
      busy($('#clear-local-data'), false);
      await refreshSaved();
    } catch (error) {
      busy($('#clear-local-data'), false);
      $('#saved-records-status').textContent = error.message || 'The records could not be cleared. Try again.';
    }
  });
  refreshSaved();
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) { submitting = false; busy(button, false); refreshScanConfig(); updateStartLabel(); }
    refreshSaved();
  });
}

if (page === 'help') {
  $('#minor-help').hidden = params.get('minor') !== '1';
  if (scanId && params.get('sensitive') !== '1') $('#continue-scan').href = reportUrl(scanId);
  // The page remains useful without JavaScript or the API; refresh only curated link targets.
  api('/api/help-links').then((data) => {
    const links = Array.isArray(data.links) ? data.links : [];
    for (const anchor of document.querySelectorAll('[data-resource]')) {
      const link = links.find((item) => item.name?.toLowerCase().startsWith(anchor.dataset.resource));
      const url = safeUrl(link?.url);
      if (url) anchor.href = url;
    }
  }).catch(() => {});
}

if (page === 'contact') {
  let attachment = null;
  const share = $('#share-report');
  share.checked = false;
  share.disabled = true;
  if (params.get('type') === 'unlock') {
    $('#contact-title').textContent = 'Uncover your additional links.';
    $('#contact-description').textContent = 'Contact 123 Reputation to request the links beyond your first 20 and discuss removal support. Sending this form requests follow-up; it does not automatically unlock results.';
    $('#contact-message').value = 'I would like to uncover the additional links in my reputation report and discuss help with removal requests.';
    $('#help-type').value = 'pr';
    $('#contact-submit').textContent = 'Request additional links →';
  }
  if (scanId) {
    $('#contact-back').href = reportUrl(scanId);
    $('#contact-back').textContent = '← Back to your local report';
    $('#success-back').href = reportUrl(scanId);
    $('#success-back').textContent = 'Back to your local report';
    $('#attachment-status').textContent = 'Loading a preview from this browser. Nothing is being shared.';
    const hitId = params.get('hit_id');
    const selectedHits = hitId === null ? undefined : [Number(hitId)];
    const validSelection = selectedHits === undefined || selectedHits.every((id) => Number.isSafeInteger(id) && id > 0);
    const previewRequest = validSelection ? assistancePreview(scanId, selectedHits) : Promise.reject(new Error('Invalid result reference.'));
    previewRequest.then((preview) => {
      if (!preview) throw new Error('Local report unavailable.');
      attachment = {
        subject_name: String(preview.subject_name || ''),
        subject_type: preview.subject_type === 'business' ? 'business' : 'person',
        country: String(preview.country || ''),
        results: (Array.isArray(preview.results) ? preview.results : []).slice(0, 20).map((result) => ({ url: String(result.url || ''), title: String(result.title || '') })),
      };
      const details = $('#attachment-subject');
      details.replaceChildren();
      for (const [label, value] of [['Subject name', attachment.subject_name], ['Subject type', attachment.subject_type], ['Country or region', attachment.country || 'No country preference']]) {
        details.append(node('dt', '', label), node('dd', '', value));
      }
      $('#attachment-results').replaceChildren(...attachment.results.map((result) => {
        const item = node('li');
        item.append(node('strong', '', result.title || 'Untitled result'), node('p', 'attachment-url', result.url));
        return item;
      }));
      $('#attachment-preview').hidden = false;
      $('#attachment-status').textContent = attachment.results.length
        ? 'Review the exact subject details and result titles/URLs below. They are sent only if you tick Include report details.'
        : 'This preview has subject details only; there are no result titles or URLs to attach. It is sent only if you choose to include it.';
      share.disabled = false;
    }).catch(() => {
      attachment = null;
      share.checked = false;
      share.disabled = true;
      $('#attachment-status').textContent = 'This report is not available in this browser. You can still send a plain assistance request without an attachment.';
    });
  }
  $('#contact-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const consent = data.has('consent');
    const shareReport = data.has('share_report');
    if (!consent) { showError($('#contact-error'), 'Confirm that you consent to sending these details for follow-up.'); return; }
    if (shareReport && !attachment) { showError($('#contact-error'), 'Load and review an attachment preview before sharing it.'); return; }
    const links = String(data.get('links') || '').split(/\s+/).map((link) => link.trim()).filter(Boolean);
    if (links.length > 20) { showError($('#contact-error'), 'Enter at most 20 links.'); return; }
    if (links.some((link) => !/^https?:\/\/\S+\.\S+/i.test(link) || link.length > 2048)) { showError($('#contact-error'), 'Enter each link as a full web address starting with https://, one per line.'); return; }
    const button = $('#contact-submit');
    busy(button, true, 'Sending your request…');
    showError($('#contact-error'), '');
    try {
      const result = await api('/api/assistance', { method: 'POST', body: {
        name: data.get('name').trim(), email: data.get('email').trim(),
        message: data.get('message').trim(), help_type: data.get('help_type'), consent,
        share_report: shareReport, ...(shareReport ? { attachment } : {}), ...(links.length ? { links } : {}),
      } });
      if (typeof result?.message === 'string' && result.message) $('#contact-success-message').textContent = result.message;
      form.hidden = true;
      $('#contact-success').hidden = false;
      $('#success-back').focus();
    } catch (error) {
      showError($('#contact-error'), `${error.message}${Number.isFinite(error.retry_after_seconds) && error.retry_after_seconds > 0 ? ` Try again in ${Math.ceil(error.retry_after_seconds)} seconds.` : ''}`);
      busy(button, false);
    }
  });
  // Native form submission stays unavailable until the consent-aware handler is ready.
  $('#contact-submit').disabled = false;
}

if (page === 'report') initReport();

function initReport() {
  let report = null;
  const isBusiness = () => report?.subject_type === 'business';
  const notMeLabel = () => isBusiness() ? 'Not our business' : 'Not me';
  let timer;
  let loading = false;
  let deleting = false;
  let stopped = false;
  let renderKey = '';
  let currentHit = null;
  let draftInfo = null;
  let discoveryVersion = 0;
  let draftVersion = 0;
  let activeDraftTemplate = '';
  let activeDraftId = '';
  const draftSaves = new Map();
  const draftSnapshots = new Map();
  const draftFailures = new Set();
  const excluded = new Map();
  const draftDialog = $('#draft-modal');
  // Opt-in AI drafting: shown only when the server reports it is enabled.
  let aiSettings = null;
  const aiButton = node('button', 'button secondary', 'Draft with AI');
  aiButton.type = 'button'; aiButton.id = 'ai-draft'; aiButton.hidden = true; aiButton.disabled = true;
  $('#generate-draft').after(aiButton);
  const aiLabel = node('div', 'notice warn', AI_DRAFT_LABEL);
  aiLabel.id = 'draft-ai-label'; aiLabel.setAttribute('role', 'status'); aiLabel.hidden = true;
  $('#draft-editor').prepend(aiLabel);
  function showAiOption(settings) {
    aiSettings = settings;
    aiButton.hidden = !aiDraftingAvailable(settings);
  }
  const terminal = new Set(['done', 'error', 'paused_budget', 'help_only', 'awaiting_import']);
  $('#contact-more-results').href = contactUrl('unlock');
  $('#expert-link').href = contactUrl('help');
  const coverageNotice = node('section', 'notice spacing-9');
  coverageNotice.id = 'scan-coverage';
  coverageNotice.append(node('strong', '', 'Missing a result you found elsewhere?'));
  const engineDetail = node('p'); engineDetail.id = 'search-engine-detail';
  const engineWarning = node('p', 'hint'); engineWarning.id = 'search-engine-warning';
  const backupDetail = node('p', 'hint'); backupDetail.id = 'search-backup-detail';
  const historyWarning = node('p', 'hint'); historyWarning.id = 'scan-history-detail';
  const providerLimitation = node('p'); providerLimitation.id = 'provider-limitation';
  const coverageDetails = node('details'); coverageDetails.id = 'search-coverage-details';
  coverageDetails.append(node('summary', '', 'See what this scan included'));
  const coverageCounts = node('p', 'hint'); coverageCounts.id = 'search-coverage-counts';
  const coverageExclusions = node('p', 'hint');
  coverageDetails.append(coverageCounts, coverageExclusions);
  coverageNotice.append(engineDetail, engineWarning, backupDetail, providerLimitation, historyWarning, coverageDetails);
  coverageNotice.append(node('p', 'hint', 'This general report does not display sensitive content. For adult intimate-content URLs you already know, use the removal queue to prepare requests.'));
  const knownUrlLink = node('a', 'button secondary compact', 'Manage known URLs for removal →');
  knownUrlLink.href = `/takedowns.html#${new URLSearchParams({ from_scan: scanId })}`;
  coverageNotice.append(knownUrlLink);
  const retainHistory = node('button', 'button secondary compact', 'Keep findings from earlier scans');
  retainHistory.type = 'button'; retainHistory.id = 'retain-scan-history';
  const historyStatus = node('p', 'hint'); historyStatus.id = 'scan-history-status';
  retainHistory.addEventListener('click', async () => {
    retainHistory.disabled = true;
    historyStatus.textContent = 'Checking earlier scans saved in this browser…';
    try {
      const result = await api(`${scanPath()}/history`, { method: 'POST', body: {}, scoped: true });
      historyStatus.textContent = result.carried_count
        ? `${result.carried_count} earlier ${result.carried_count === 1 ? 'finding added' : 'findings added'}. These are previous observations, not a new search.`
        : 'No additional findings from earlier scans with the same name and identity context.';
      await poll();
    } catch (error) { historyStatus.textContent = error.message; }
    finally { retainHistory.disabled = false; }
  });
  coverageNotice.append(retainHistory, historyStatus);
  $('.report-layout').before(coverageNotice);
  let currentSearchEngines = [];
  let currentGoogleBackupProvider = null;
  function renderCoverage(next) {
    const view = searchCoverageView(next, currentSearchEngines, currentGoogleBackupProvider);
    engineDetail.textContent = view.engineText;
    engineWarning.textContent = view.engineNotice;
    engineWarning.hidden = !view.engineNotice;
    backupDetail.textContent = view.backupNotice;
    backupDetail.hidden = !view.backupNotice;
    historyWarning.textContent = view.historyText;
    historyWarning.hidden = !view.historyText;
    providerLimitation.textContent = view.limitation;
    coverageCounts.textContent = view.countText;
    coverageExclusions.textContent = view.exclusions;
  }
  if (!scanId || scanId.length > 200) {
    showError($('#report-error'), 'This report link is missing a valid scan reference. Start a new scan to continue.');
    $('#scan-status').textContent = 'Report unavailable';
    $('#scan-progress').value = 0;
    $('#delete-scan').hidden = true;
    $('#empty-results').hidden = true;
    return;
  }

  function makeButton(label, className, handler) {
    const button = node('button', `button compact ${className}`, label);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  }
  function hitCard(hit, sameName = false) {
    const card = node('article', 'result-card');
    const top = node('div', 'card-top');
    const validUrl = safeUrl(hit.url);
    let host = 'Source unavailable';
    if (validUrl) host = new URL(validUrl).hostname.replace(/^www\./, '');
    top.append(node('span', 'source', host));
    const labels = resultLabelView(hit, { business: isBusiness() });
    const badges = node('div', 'result-labels');
    badges.setAttribute('aria-label', 'Automatic topic and suggested review priority');
    badges.append(node('span', `result-topic result-topic--${labels.tone}`, labels.topicLabel),
      node('span', `result-priority result-priority--${labels.priority}`, labels.priorityLabel));
    top.append(badges);
    const heading = node('h3');
    if (validUrl) {
      const link = node('a', '', hit.title || host);
      link.href = validUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', `${hit.title || host} (opens external source)`);
      heading.append(link);
    } else heading.textContent = hit.title || 'Mention to review';
    const detail = node('div', 'result-detail');
    detail.append(node('strong', 'result-identity', labels.identityLabel));
    detail.append(node('p', 'result-label-note', 'Automatic assessment · check the context before acting.'));
    const explanation = node('details', 'result-explanation');
    explanation.append(node('summary', '', 'Why this label?'), node('p', '', labels.explanation),
      node('p', '', labels.priorityExplanation), node('p', '', labels.identityExplanation));
    detail.append(explanation);
    const actions = node('div', 'card-actions');
    actions.append(makeButton(hit.status === 'not_me' ? 'Draft clarification' : hit.category === 'neutral' ? 'Review request options' : 'Prepare takedown request', 'primary', () => openDraft(hit)));
    if (hit.status !== 'not_me') actions.append(makeButton(notMeLabel(), 'secondary', (event) => changeStatus(hit, 'not_me', event.currentTarget)));
    if (!sameName && hit.status !== 'resolved') actions.append(makeButton('Resolved', 'ghost', (event) => changeStatus(hit, 'resolved', event.currentTarget)));
    const help = node('a', 'button compact ghost', 'Expert help');
    help.href = contactUrl('help', hit.id);
    actions.append(help);
    const tracker = node('div', 'tracker');
    const label = node('label', '', 'Track this mention');
    const select = node('select');
    select.id = `status-${String(hit.id).replace(/[^a-z0-9-]/gi, '')}-${sameName ? 'other' : 'main'}`;
    label.htmlFor = select.id;
    const currentStatus = hit.status || 'new';
    const statuses = ['sent', 'removed', 'refused', 'escalated', 'resolved', 'not_me'];
    if (!statuses.includes(currentStatus)) {
      const current = node('option', '', statusLabels[currentStatus] || 'Not reviewed');
      current.value = currentStatus; current.disabled = true;
      select.append(current);
    }
    for (const status of statuses) {
      const option = node('option', '', status === 'not_me' ? notMeLabel() : statusLabels[status]);
      option.value = status; select.append(option);
    }
    select.value = currentStatus;
    select.addEventListener('change', () => changeStatus(hit, select.value, select));
    tracker.append(label, select);
    card.append(top, heading);
    if (hit.discovery_origin === 'previous_scan') {
      const date = new Date(hit.previous_observed_at || hit.last_seen_at || hit.created_at);
      card.append(node('p', 'hint', `Previously found · not returned in this scan${Number.isFinite(date.getTime()) ? ` · observed ${date.toLocaleDateString()}` : ''}. Removal has not been verified.`));
    }
    if (validUrl) card.append(node('p', 'result-url', hit.url));
    card.append(node('p', 'snippet', hit.snippet || 'No text preview is available for this mention.'), detail, actions, tracker);
    return card;
  }

  function renderResults(force = false) {
    if (!report) return;
    const eligible = (hit) => hit.category !== 'sensitive_intimate' && hit.status !== 'not_me';
    const primary = (report.shown || []).filter(eligible).slice(0, 20);
    const primaryIds = new Set(primary.map((hit) => String(hit.id)));
    const extra = (report.extra || []).filter((hit) => eligible(hit) && !primaryIds.has(String(hit.id)));
    // Resolved or removed mentions leave the main list but stay reopenable below.
    const finished = (hit) => ['resolved', 'removed'].includes(hit.status);
    const shown = primary.filter((hit) => !finished(hit));
    const done = primary.filter(finished);
    const preview = additionalResultPreview(extra);
    const other = (report.sameName || []).filter((hit) => hit.category !== 'sensitive_intimate' && hit.status !== 'not_me');
    for (const hit of [...(report.sameName || []), ...(report.shown || []), ...(report.extra || []), ...(report.notMe || [])]) {
      if (hit.status === 'not_me' && hit.category !== 'sensitive_intimate') excluded.set(hit.id, hit);
    }
    const key = JSON.stringify([shown, done, other, [...excluded.values()], report.status, preview, report.sameNameCount, report.subject_type]);
    if (!force && key === renderKey) return;
    renderKey = key;
    const flagged = shown.filter(hit => hit.category !== 'neutral');
    const ordinary = shown.filter(hit => hit.category === 'neutral');
    const cards = flagged.length ? [node('p', 'eyebrow', 'Concerning mentions · review the context'), ...flagged.map(hit => hitCard(hit))] : [];
    if (ordinary.length) {
      const secondary = node('section', 'stack');
      secondary.append(node('h2', '', isBusiness() ? 'Other business mentions' : 'Other personal mentions'),
        node('p', 'hint', 'These are ordinary name matches. Automated rules did not flag a concern; check whether each result is about you and relevant to your request.'));
      const ordinaryCards = node('div', 'result-list');
      ordinaryCards.append(...ordinary.map(hit => hitCard(hit)));
      secondary.append(ordinaryCards); cards.push(secondary);
    }
    $('#results').replaceChildren(...cards);
    $('#result-count').textContent = `${shown.length} visible · ${flagged.length} flagged`;
    $('#empty-results').hidden = shown.length > 0;
    if (!shown.length) {
      const incomplete = report.partial || ['error', 'paused_budget'].includes(report.status);
      const allDone = !incomplete && done.length > 0;
      $('#empty-results h3').textContent = allDone ? 'All mentions dealt with' : incomplete ? 'Search incomplete' : report.status === 'done' ? 'No prioritised mentions to show' : 'Building your picture';
      $('#empty-results p').textContent = allDone ? 'Every mention here is marked resolved or removed. You’ll find them under Done.' : incomplete
        ? 'Some searches have not completed. This is not a finding that no concerning content exists. Retry the scan to continue.'
        : report.status === 'done'
        ? 'This scan did not surface a qualifying mention. Search coverage is limited; this does not confirm that no concerning content exists.'
        : 'Mentions that need your attention will appear here. You can review them as the scan continues.';
    }
    $('#more-banner').hidden = extra.length === 0;
    $('#more-count').textContent = `${preview.count} additional ${preview.count === 1 ? 'link found' : 'links found'}`;
    $('#more-preview').replaceChildren(...preview.sources.map((source) => {
      const item = node('li', 'locked-result-preview');
      item.append(node('strong', '', source.domain), node('span', 'hint', `${source.count} ${source.count === 1 ? 'link' : 'links'} · Contact us for details`));
      const placeholder = node('span', 'locked-result-lines');
      placeholder.setAttribute('aria-hidden', 'true');
      item.append(placeholder);
      return item;
    }));
    const sameCount = Number(report.sameNameCount) || other.length;
    $('#same-name').hidden = sameCount === 0 && other.length === 0;
    $('#same-name-title').textContent = `${sameCount} ${sameCount === 1 ? 'result may' : 'results may'} ${isBusiness()
      ? 'refer to a different business with a similar name' : 'refer to someone else with your name'}`;
    $('#same-name-results').replaceChildren(...other.map((hit) => hitCard(hit, true)));
    $('#done-section').hidden = done.length === 0;
    $('#done-title').textContent = `Done (${done.length})`;
    $('#done-results').replaceChildren(...done.map((hit) => hitCard(hit)));
    $('#not-me-section').hidden = excluded.size === 0;
    $('#not-me-results').replaceChildren(...[...excluded.values()].map((hit) => hitCard(hit, true)));
  }

  function renderReport(next) {
    report = next;
    const business = isBusiness();
    document.title = business ? 'Business report — 123 Reputation' : 'Your report — 123 Reputation';
    $('#report-name').textContent = next.full_name
      ? (business ? `Report for ${next.full_name}` : `Your report, ${next.full_name}.`)
      : (business ? 'Your business report' : 'Your report');
    $('#report-kind').textContent = business ? 'Your business reputation scan' : 'Your reputation scan';
    $('#report-intro').textContent = business
      ? 'Review each mention, check whether it refers to your business, and decide what to do next.'
      : 'Review each mention, check whether it is about you, and decide what to do next.';
    $('#report-match-notice').textContent = business
      ? 'Labels and business matches are automated estimates, not evidence that an allegation is true or a page refers to your business.'
      : 'Labels and identity matches are automated estimates, not evidence that an allegation is true or a page is about you.';
    $('#same-name-hint').textContent = business
      ? 'These may describe a different business. Mark a result “Not our business” before preparing a clarification request.'
      : 'These may describe a different person. Mark a result “Not me” before preparing a clarification request.';
    $('#not-me-title').textContent = business ? 'Marked as another business' : 'Marked as someone else';
    $('#delete-scan').textContent = business ? 'Delete business scan' : 'Delete my scan';
    $('#owns-content-copy').textContent = business
      ? 'The business owns the copyright to the copied work, and I am authorised to act for it.'
      : 'I own the copyright to the copied content.';
    $('#draft-accurate-copy').textContent = business
      ? 'I have reviewed and edited this request, replaced any placeholders, confirm the statements are accurate, and am authorised to send it for the business.'
      : 'I have reviewed and edited this request, replaced any placeholders, and confirm that the statements are accurate.';
    const mock = next.provider === 'mock' || next.is_mock === true;
    $('#mock-banner').hidden = !mock;
    $('#sensitive-banner').hidden = !next.helpRequired;
    $('#incomplete-banner').hidden = !next.partial && !['error', 'paused_budget'].includes(next.status);
    const statuses = { planning: 'Planning your scan', searching: 'Searching and reviewing mentions',
      classifying: 'Reviewing search snippets', enriching: 'Reviewing search snippets', done: 'Search requests completed',
      awaiting_import: 'Waiting for search results', paused_budget: 'Scan paused', error: 'Scan incomplete — retry available',
      help_only: 'Specialist support is available' };
    $('#scan-status').textContent = statuses[next.status] || 'Working on your scan';
    const total = Number(next.progress?.total) || 0;
    const completed = Math.min(total, Number(next.progress?.completed) || 0);
    $('#progress-count').textContent = total ? `${completed} / ${total} queries` : '';
    const progress = $('#scan-progress');
    if (total || terminal.has(next.status)) { progress.max = total || 1; progress.value = next.status === 'done' ? (total || 1) : completed; }
    else progress.removeAttribute('value');
    $('#progress-detail').textContent = next.status === 'done' ? `${next.coverage?.reviewable ?? next.progress?.hits ?? 0} name matches available for review. ${next.coverage?.flagged ?? 0} flagged by automated rules. Flagged mentions appear first; ordinary matches also need your review.${next.coverage?.professional ? ` ${next.coverage.professional} professional or directory matches kept out of this personal-results list.` : ''}`
      : next.status === 'paused_budget' ? (next.error || 'The search allowance has been reached. Progress is saved in this browser; try again later.')
      : next.status === 'error' ? (next.error || 'Progress is saved in this browser. Use Retry scan to continue.')
      : next.status === 'awaiting_import' ? 'Prepared queries are saved in this browser. No report is automatically shared.'
      : 'Keep this page open while the scan runs. Progress is saved in this browser between steps.';
    renderCoverage(next);
    $('#retry-scan').hidden = !['error', 'paused_budget'].includes(next.status);
    $('#operator-resume').hidden = next.error_code !== 'operator_sign_in_required';
    $('#session-notice').hidden = next.status !== 'awaiting_import';
    if (next.status === 'awaiting_import') {
      const queries = next.queries || [];
      $('#pending-queries').textContent = queries.map((query) => typeof query === 'string' ? query : query.q || query.query || '').join('\n') || 'No pending queries to show.';
    }
    const queriesUsed = Number(next.usage?.serp_queries) || 0;
    $('#usage-detail').textContent = mock ? 'Fictional test results. No live search was run.'
      : next.provider === 'session' ? 'These results are stored in this browser. The scan is free to you.'
      : `${next.provider === 'searxng' ? next.google_backup_providers?.includes('serpapi') ? 'Sources: SearXNG live web search and Google via SerpApi. ' : 'Source: SearXNG live web search. ' : ''}${queriesUsed} search ${queriesUsed === 1 ? 'request' : 'requests'} submitted. Results are saved in this browser; source pages were not fetched.${next.provider === 'searxng' ? ' Country was used only for local identity matching. Autocomplete was not searched.' : ''}`;
    const allowance = next.allowance;
    $('#allowance-detail').textContent = allowance?.operator
      ? 'This scan last ran with operator access. Operator scans have no daily start limit.'
      : Number.isSafeInteger(allowance?.remaining_scans) && Number.isFinite(allowance?.reset_at)
        ? `When this scan’s permit was issued, ${allowance.remaining_scans} public scan ${allowance.remaining_scans === 1 ? 'slot remained' : 'slots remained'} for that network before ${new Date(allowance.reset_at).toUTCString()}. Other people on the network share the allowance.`
        : '';
    renderResults();
  }

  async function poll() {
    if (loading || stopped || deleting || draftDialog.open || $('#delete-modal').open) return;
    clearTimeout(timer);
    loading = true;
    try {
      const [next, settings] = await Promise.all([api(scanPath()), api('/api/config').catch(() => null)]);
      currentSearchEngines = settings?.search_engines || [];
      currentGoogleBackupProvider = liveSearchConsentView(settings).backupProvider;
      showAiOption(settings);
      if (deleting || stopped) return;
      renderReport(next);
      showError($('#report-error'), '');
      if (!terminal.has(next.status)) timer = setTimeout(poll, 1500);
    } catch (error) {
      showError($('#report-error'), error.message);
      $('#scan-status').textContent = error.status === 404 ? 'Scan not found in this browser' : 'Unable to update this scan';
      $('#retry-scan').hidden = error.status === 404 || error.status === 410;
      if (error.status === 404 || error.status === 410) {
        $('#delete-scan').hidden = true;
        report = null;
        excluded.clear();
        for (const id of ['results', 'done-results', 'same-name-results', 'not-me-results']) $(`#${id}`).replaceChildren();
        for (const id of ['more-banner', 'done-section', 'same-name', 'not-me-section', 'session-notice', 'empty-results']) $(`#${id}`).hidden = true;
        $('#report-name').textContent = 'Report unavailable';
        $('#result-count').textContent = '';
        $('#progress-count').textContent = '';
        $('#scan-progress').value = 0;
        $('#progress-detail').textContent = 'Use the browser profile where this scan was saved. It may have been deleted or cleared with site data. Older server reports are not loaded here.';
      }
    } finally { loading = false; }
  }

  async function changeStatus(hit, status, control) {
    const previous = hit.status || 'new';
    control.disabled = true;
    try {
      await api(`/api/hit/${encodeURIComponent(hit.id)}`, { method: 'PATCH', scoped: true, body: { status } });
      hit.status = status;
      if (status === 'not_me') excluded.set(hit.id, hit);
      else excluded.delete(hit.id);
      renderKey = '';
      renderResults(true);
      toast(status === 'not_me'
        ? (isBusiness() ? 'Marked as another business. Clarification options are below.' : 'Marked as someone else. Clarification options are below.')
        : `Status updated: ${statusLabels[status]}.`);
      if (!loading) await poll();
    } catch (error) {
      if (control.tagName === 'SELECT') control.value = previous;
      toast(error.message);
    } finally { control.disabled = false; }
  }

  function clearDraft() {
    draftVersion++;
    activeDraftTemplate = '';
    activeDraftId = '';
    $('#draft-editor').hidden = true;
    $('#draft-accurate').checked = false;
    $('#draft-subject').value = '';
    $('#draft-body').value = '';
    $('#draft-subject').disabled = false;
    $('#draft-body').disabled = false;
    $('#draft-feedback').textContent = '';
    aiLabel.hidden = true;
    gateDraft();
  }
  function showDraft(draft) {
    $('#draft-email').value = draft.sender_email || draftInfo?.sender_email || '';
    activeDraftTemplate = draft.template || $('#draft-template').value;
    activeDraftId = draft.id || '';
    $('#draft-template').value = activeDraftTemplate;
    $('#draft-subject').value = draft.subject || '';
    $('#draft-body').value = draft.body || '';
    $('#draft-subject').disabled = false;
    $('#draft-body').disabled = false;
    draftSnapshots.set(`${currentHit.id}:${activeDraftTemplate}`, { subject: $('#draft-subject').value, body: $('#draft-body').value });
    $('#draft-editor').hidden = false;
    aiLabel.hidden = draft.source !== 'ai';
    $('#draft-feedback').textContent = $('#draft-email').value.trim()
      ? 'This draft is saved in this browser. Edits save as you type; nothing is sent automatically.'
      : 'Preview only: your contact email is a placeholder. You can edit this draft now. Add your email and prepare the draft again before using the sending actions.';
    gateDraft();
  }
  function saveDraft() {
    if (!currentHit || !activeDraftTemplate || $('#draft-editor').hidden || stopped || deleting) return Promise.resolve();
    const hitId = currentHit.id;
    const template = activeDraftTemplate;
    const draftId = activeDraftId;
    const key = `${hitId}:${template}`;
    const snapshot = { subject: $('#draft-subject').value, body: $('#draft-body').value };
    const previous = draftSnapshots.get(key);
    if (previous?.subject === snapshot.subject && previous?.body === snapshot.body && !draftFailures.has(key)) return draftSaves.get(hitId) || Promise.resolve();
    draftFailures.delete(key);
    draftSnapshots.set(key, snapshot);
    $('#draft-feedback').textContent = 'Saving your edits in this browser…';
    const saving = (draftSaves.get(hitId) || Promise.resolve()).catch(() => {}).then(() =>
      api(`/api/hit/${encodeURIComponent(hitId)}/draft`, { method: 'PATCH', scoped: true, body: { ...snapshot, ...(draftId ? { draft_id: draftId } : {}) } }));
    draftSaves.set(hitId, saving);
    const isCurrent = () => currentHit?.id === hitId && activeDraftTemplate === template && draftSnapshots.get(key) === snapshot;
    saving.then(() => {
      if (isCurrent()) {
        showError($('#draft-error'), '');
        $('#draft-feedback').textContent = 'Edits saved in this browser. Nothing has been sent.';
      }
    }, (error) => {
      if (draftSaves.get(hitId) === saving) draftFailures.add(key);
      if (isCurrent()) showError($('#draft-error'), `Your latest edits could not be saved. Keep this page open and copy them before leaving. ${error.message || ''}`);
    });
    return saving;
  }
  function gateDraft() {
    const allowed = $('#draft-accurate').checked && !$('#draft-editor').hidden && Boolean($('#draft-email').value.trim()) && $('#draft-email').checkValidity();
    for (const id of ['copy-draft', 'open-form', 'open-google', 'email-draft', 'mark-sent']) $(`#${id}`).disabled = !allowed;
  }
  const emailSending = setupEmailSending({ context: () => ({ record_id: scanId, hit_id: currentHit?.id, message_kind: activeDraftTemplate === 'follow_up' ? 'followup' : 'initial' }), beforeSend: () => activeDraftTemplate === 'follow_up' ? stopItemFollowups(scanId,currentHit?.id,'cancelled') : Promise.resolve(), canSchedule: () => ['found','drafted','new','unreviewed'].includes(currentHit?.status), canSend: () => report?.provider !== 'mock', onAccepted: async () => {
    if (!currentHit) return;
    await saveDraft();
    await api(`/api/hit/${encodeURIComponent(currentHit.id)}`, { method: 'PATCH', scoped: true, body: { status: 'sent' } });
    currentHit.status = 'sent';
    renderResults(true);
    toast('Email accepted by your provider. Report marked as sent.');
  } });
  function emailContacts(info) {
    const contacts = [info.channel?.email, info.abuse?.hostAbuse, info.abuse?.registrarAbuse].flat().filter(Boolean);
    return [...new Set(contacts.filter((email) => typeof email === 'string' && /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/.test(email)))];
  }
  function reportingForm(info) {
    return safeUrl(info.channel?.form) || safeUrl(info.abuse?.cloudflare === true ? 'https://abuse.cloudflare.com' : info.abuse?.cloudflare);
  }
  function renderChannels(info) {
    emailSending.setChannel(info.channel);
    const channels = $('#draft-channels');
    channels.replaceChildren();
    // One recommended route up front; everything else folds away.
    const primary = node('div');
    const more = node('details', 'channel-more');
    more.append(node('summary', '', 'More places to report'));
    more.hidden = true;
    channels.append(primary, more);
    function add(title, description, extra = false) {
      const item = node('div', 'channel-item'); item.append(node('strong', '', title), node('p', '', description));
      if (extra) { more.append(item); more.hidden = false; } else primary.replaceChildren(item);
    }
    if (info.channel) add(`Report to ${info.channel.name || 'the website'}`, info.channel.how || 'Check the platform’s reporting requirements before you submit.');
    else {
      const lookupHit = currentHit;
      add('Finding where to report this…', 'Only the website’s address is checked. The page itself isn’t opened.');
      lookupReportingContact(lookupHit.url).then(result => {
        if (currentHit !== lookupHit || draftInfo?.channel) return;
        const selected = result.contacts?.[0];
        emailSending.setContacts(result.contacts || []);
        add(selected ? `Report to ${selected.name}` : 'No reporting contact found', selected
          ? selected.how
          : 'Ask us to find the right publisher or host.');
        for (const alternative of (result.contacts || []).slice(1)) add(alternative.name, `${alternative.email || alternative.form}. ${alternative.how}`, true);
      }).catch(() => {
        if (currentHit === lookupHit) add('Couldn’t find where to report this', 'Ask us to find the right publisher or host.');
      });
    }
    if (info.google?.url) add('Google search results', `${info.google.label || 'Google removal route'}. Removing a search result doesn’t remove the original page.`, true);
    if (info.abuse?.host) add('Hosting provider', info.abuse.host, true);
    if (info.abuse?.registrar) add('Domain registrar', info.abuse.registrar, true);
    const emails = emailContacts(info);
    if (emails.length) add('Abuse contacts', emails.join(' · '), true);
    if (info.abuse?.cloudflare) add('Cloudflare', 'Use the Cloudflare abuse form and pick the matching report type.', true);
    $('#open-form').hidden = !reportingForm(info);
    $('#open-google').hidden = !safeUrl(info.google?.url);
    $('#email-draft').hidden = !emails.length;
    $('#email-route-field').hidden = emails.length < 2;
    $('#email-route').replaceChildren(...emails.map((email) => { const option = node('option', '', email); option.value = email; return option; }));
  }
  async function discoverTemplates() {
    if (!currentHit) return;
    const request = ++discoveryVersion;
    const hit = currentHit;
    clearDraft();
    showError($('#draft-error'), '');
    const generate = $('#generate-draft');
    generate.disabled = true;
    aiButton.disabled = true;
    $('#draft-template').disabled = true;
    $('#draft-template').replaceChildren(node('option', '', 'Loading request types…'));
    try {
      await (draftSaves.get(hit.id) || Promise.resolve());
      const info = await api(`/api/hit/${encodeURIComponent(hit.id)}/draft`, { method: 'POST', scoped: true, body: { owns_content: $('#owns-content').checked } });
      if (request !== discoveryVersion || currentHit?.id !== hit.id) return;
      draftInfo = info;
      $('#draft-email').value = info.sender_email || '';
      renderChannels(info);
      const templates = (info.templates || []).map((item) => typeof item === 'string' ? { id: item, label: item.replaceAll('_', ' ') } : item);
      $('#draft-template').replaceChildren(...templates.map((template) => { const option = node('option', '', template.label || template.id); option.value = template.id; return option; }));
      if (hit.status === 'not_me' && templates.some((template) => template.id === 'same_name')) $('#draft-template').value = 'same_name';
      $('#draft-template').disabled = !templates.length;
      generate.disabled = !templates.length;
      aiButton.disabled = !templates.length;
      if (info.saved_draft && templates.some((template) => template.id === info.saved_draft.template)) showDraft(info.saved_draft);
      if (!templates.length) showError($('#draft-error'), hit.status === 'not_me'
        ? 'No clarification template is available for this match. You can ask for expert help from the report.'
        : isBusiness() ? 'No request template is available for this result. If it refers to a different business, mark it “Not our business” first.'
          : 'No request template is available for this result. If this is about someone else, mark it “Not me” first.');
    } catch (error) {
      if (request === discoveryVersion) showError($('#draft-error'), error.message);
    }
  }
  function openDraft(hit) {
    if (hit.category === 'sensitive_intimate') { location.assign('/help.html'); return; }
    currentHit = hit;
    emailSending.setChannel(null);
    draftInfo = null;
    $('#draft-title').textContent = isBusiness() ? 'Prepare a business removal request' : 'Prepare a removal request';
    $('#draft-source').textContent = hit.title || hit.url || '';
    $('#owns-content').checked = false;
    $('#owns-content').disabled = Boolean(report?.is_minor);
    $('#draft-channels').replaceChildren();
    clearTimeout(timer);
    clearDraft();
    api('/api/config').then(showAiOption).catch(() => showAiOption(null));
    draftDialog.showModal();
    discoverTemplates();
  }
  draftDialog.addEventListener('close', () => {
    saveDraft();
    discoveryVersion++; draftVersion++;
    if (report && !terminal.has(report.status)) timer = setTimeout(poll, 1500);
  });
  $('#owns-content').addEventListener('change', discoverTemplates);
  $('#draft-template').addEventListener('change', clearDraft);
  $('#draft-accurate').addEventListener('change', gateDraft);
  $('#draft-email').addEventListener('input', () => {
    saveDraft();
    clearDraft();
    $('#draft-feedback').textContent = 'Prepare a draft with this contact email, then review it before sending.';
  });
  for (const id of ['draft-subject', 'draft-body']) $(`#${id}`).addEventListener('input', () => { saveDraft(); $('#draft-accurate').checked = false; gateDraft(); });
  $('#generate-draft').addEventListener('click', async () => {
    if (!currentHit || !$('#draft-template').value) return;
    if (!$('#draft-email').reportValidity()) return;
    const pendingSave = saveDraft();
    const request = ++draftVersion;
    const hitId = currentHit.id;
    const template = $('#draft-template').value;
    const ownsContent = $('#owns-content').checked;
    const button = $('#generate-draft');
    busy(button, true, 'Preparing draft…');
    $('#draft-subject').disabled = true;
    $('#draft-body').disabled = true;
    $('#draft-accurate').checked = false;
    gateDraft();
    showError($('#draft-error'), '');
    try {
      await pendingSave;
      await (draftSaves.get(hitId) || Promise.resolve());
      const info = await api(`/api/hit/${encodeURIComponent(hitId)}/draft`, { method: 'POST', scoped: true, body: {
        template, owns_content: ownsContent, sender_email: $('#draft-email').value.trim(),
      } });
      if (request !== draftVersion || currentHit?.id !== hitId) return;
      if (typeof info.draft?.body !== 'string') throw new Error('A draft could not be prepared. Please try again.');
      draftInfo = { ...draftInfo, ...info };
      renderChannels(draftInfo);
      showDraft({ ...info.draft, template });
      $('#draft-body').focus();
      gateDraft();
    } catch (error) { if (request === draftVersion) showError($('#draft-error'), error.message); }
    finally {
      busy(button, false);
      if (request === draftVersion) { $('#draft-subject').disabled = false; $('#draft-body').disabled = false; }
    }
  });
  aiButton.addEventListener('click', async () => {
    if (!currentHit || !$('#draft-template').value || !aiDraftingAvailable(aiSettings)) return;
    if (!$('#draft-email').reportValidity()) return;
    const template = $('#draft-template').value;
    const hitId = currentHit.id;
    // Fresh, explicit consent for this one request. Nothing is sent if cancelled.
    const consent = await requestAiConsent({ providerName: aiProviderName(aiSettings),
      requestLabel: $('#draft-template').selectedOptions[0]?.textContent || template });
    if (!consent || currentHit?.id !== hitId || $('#draft-template').value !== template) return;
    const pendingSave = saveDraft();
    const request = ++draftVersion;
    const ownsContent = $('#owns-content').checked;
    busy(aiButton, true, 'Writing AI draft…');
    $('#generate-draft').disabled = true;
    $('#draft-subject').disabled = true;
    $('#draft-body').disabled = true;
    $('#draft-accurate').checked = false;
    gateDraft();
    showError($('#draft-error'), '');
    try {
      await pendingSave;
      await (draftSaves.get(hitId) || Promise.resolve());
      const result = await api(`/api/hit/${encodeURIComponent(hitId)}/draft-ai`, { method: 'POST', scoped: true, body: {
        consent: true, template, owns_content: ownsContent, sender_email: $('#draft-email').value.trim(),
        ...(consent.facts ? { facts: consent.facts } : {}),
      } });
      if (request !== draftVersion || currentHit?.id !== hitId) return;
      if (typeof result?.draft?.body !== 'string') throw new Error('The AI service returned no usable draft. Use the template draft instead.');
      showDraft({ ...result.draft, template });
      $('#draft-feedback').textContent = 'AI draft saved in this browser only. Check every detail, replace any placeholders and edit it before sending. Nothing has been sent.';
      $('#draft-body').focus();
    } catch (error) {
      if (request === draftVersion) showError($('#draft-error'), `${error.message || 'The AI draft could not be prepared.'}${/template/i.test(error.message || '') ? '' : ' You can still use “Prepare email draft” for a template.'}`);
    } finally {
      busy(aiButton, false);
      $('#generate-draft').disabled = !$('#draft-template').value;
      if (request === draftVersion) { $('#draft-subject').disabled = false; $('#draft-body').disabled = false; }
    }
  });
  $('#copy-draft').addEventListener('click', async () => {
    if (!$('#draft-accurate').checked) return;
    try {
      await navigator.clipboard.writeText(`Subject: ${$('#draft-subject').value}\n\n${$('#draft-body').value}`);
      $('#draft-feedback').textContent = 'Request copied. Review the destination form before submitting.';
    } catch {
      $('#draft-body').focus(); $('#draft-body').select();
      $('#draft-feedback').textContent = 'Automatic copying is unavailable. Your message is selected so you can copy it manually.';
    }
  });
  $('#open-form').addEventListener('click', () => { if ($('#draft-accurate').checked && draftInfo) openExternal(reportingForm(draftInfo)); });
  $('#open-google').addEventListener('click', () => { if ($('#draft-accurate').checked && draftInfo) openExternal(draftInfo.google?.url); });
  $('#email-draft').addEventListener('click', () => {
    if (!$('#draft-accurate').checked || !draftInfo) return;
    const address = $('#email-route').value;
    if (!emailContacts(draftInfo).includes(address)) return;
    location.href = `mailto:${encodeURIComponent(address)}?subject=${encodeURIComponent($('#draft-subject').value)}&body=${encodeURIComponent($('#draft-body').value)}`;
    $('#draft-feedback').textContent = 'Your email app opens a draft. Choose your own sending account, review the request, then send it. Opening this draft does not send it or remove the page.';
  });
  $('#mark-sent').addEventListener('click', async () => {
    if (!$('#draft-accurate').checked || !currentHit) return;
    const hit = currentHit;
    const button = $('#mark-sent');
    busy(button, true, 'Saving…');
    try {
      await saveDraft();
      if (activeDraftTemplate === 'follow_up') await stopItemFollowups(scanId,hit.id,'cancelled');
      await api(`/api/hit/${encodeURIComponent(hit.id)}`, { method: 'PATCH', scoped: true, body: { status: 'sent' } });
      hit.status = 'sent'; excluded.delete(hit.id);
      renderResults(true);
      $('#draft-feedback').textContent = 'Marked as sent. You can update the status when you receive a response.';
      toast('Request marked as sent.');
      poll();
    } catch (error) { showError($('#draft-error'), error.message); }
    finally { busy(button, false); gateDraft(); }
  });

  $('#retry-scan').addEventListener('click', async () => {
    const button = $('#retry-scan');
    busy(button, true, 'Retrying…');
    try {
      if (report && ['error', 'paused_budget'].includes(report.status)) await api(`${scanPath()}/retry`, { method: 'POST', scoped: true });
      await poll();
    } catch (error) { showError($('#report-error'), error.message); }
    finally { busy(button, false); }
  });
  $('#delete-scan').addEventListener('click', () => { clearTimeout(timer); $('#delete-modal').showModal(); });
  $('#delete-modal').addEventListener('close', () => {
    if (report && !terminal.has(report.status) && !deleting) timer = setTimeout(poll, 1500);
  });
  $('#confirm-delete').addEventListener('click', async () => {
    const button = $('#confirm-delete');
    busy(button, true, 'Deleting…');
    deleting = true;
    clearTimeout(timer);
    try {
      await api(scanPath(), { method: 'DELETE', scoped: true });
      stopped = true;
      location.replace('/?deleted=1');
    } catch (error) {
      deleting = false;
      showError($('#delete-error'), error.message);
      busy(button, false);
      if (report && !terminal.has(report.status)) timer = setTimeout(poll, 1500);
    }
  });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
  window.addEventListener('pageshow', (event) => { if (event.persisted) { stopped = false; poll(); } });
  poll();
}
